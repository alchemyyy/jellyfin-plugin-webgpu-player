using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// Stateless rules for reading decoder packages: WebAssembly modules whose custom section carries the decoder's <c>//!</c> header.
/// The plugin reads only what it offers and shows: the id, name, kind, codecs, output formats, and monochrome support, and a video decoder's header text, which a client's engine reads.
/// The engine's book defines the format, and a client's engine runs every check of its own when it loads a package.
/// </summary>
public static partial class DecoderPackageFunctions
{
    /// <summary>
    /// The file extension of decoder packages.
    /// </summary>
    public const string FileExtension = ".wasm";

    /// <summary>
    /// The content type the plugin serves packages with.
    /// </summary>
    public const string ContentType = "application/wasm";

    /// <summary>
    /// The kind of a video decoder package.
    /// </summary>
    public const string VideoKind = "video";

    /// <summary>
    /// The kind of an audio decoder package.
    /// </summary>
    public const string AudioKind = "audio";

    /// <summary>
    /// The largest package the plugin accepts; the largest bundled one, AV1, is about 2 MB.
    /// </summary>
    public const int MaximumByteLength = 64 * 1024 * 1024;

    // The failed checks, as the engine's loader names them
    private const string SizeCode = "package-size";
    private const string InvalidCode = "package-invalid";
    private const string SectionMissingCode = "package-section-missing";
    private const string SectionRepeatedCode = "package-section-repeated";
    private const string EncodingCode = "package-encoding";
    private const string ManifestCode = "package-manifest";

    private const int MaximumIdLength = 64;
    private const byte CustomSectionId = 0;
    private const int LEB128PayloadMask = 0x7F;
    private const int LEB128Continuation = 0x80;
    private const int LEB128BitsPerByte = 7;
    // A u32 needs at most five LEB128 bytes
    private const int MaximumU32LEB128ByteLength = 5;
    private const string HeaderPrefix = "//!";
    private const string IdDirective = "id";
    private const string NameDirective = "name";
    private const string DecoderDirective = "decoder";
    private const string AcceptsDirective = "accepts";
    private const string OutputDirective = "output";
    private const string MonochromeDirective = "monochrome";
    // The one value of the monochrome directive
    private const string MonochromeValue = "yes";
    private const char ListSeparator = ',';
    private const char LineFeed = '\n';
    private const char CarriageReturn = '\r';

    private static readonly UTF8Encoding StrictUTF8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    // The directives every package declares; a video package also declares its output
    private static readonly string[] RequiredDirectives = [IdDirective, NameDirective, DecoderDirective, AcceptsDirective];

    // The WebAssembly preamble: the magic and binary version 1
    private static ReadOnlySpan<byte> Preamble => [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];

    /// <summary>
    /// Reads a package file's header from its decoder section.
    /// </summary>
    /// <param name="bytes">The package file.</param>
    /// <param name="sectionName">The custom section that carries the header, which the add-on manifest relays from the engine's package format.</param>
    /// <returns>What the header declares, or the check the file failed.</returns>
    public static (DecoderPackageInfo? Package, ModuleProblem? Problem) ReadPackage(byte[] bytes, string sectionName)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length > MaximumByteLength)
        {
            return (null, new ModuleProblem(SizeCode, string.Create(CultureInfo.InvariantCulture, $"{bytes.Length} > {MaximumByteLength}")));
        }

        (int SectionStart, int SectionLength, ModuleProblem? Problem) section = FindCustomSection(bytes, sectionName);
        if (section.Problem is not null)
        {
            return (null, section.Problem);
        }

        string source;
        try
        {
            source = StrictUTF8.GetString(bytes, section.SectionStart, section.SectionLength);
        }
        catch (DecoderFallbackException exception)
        {
            return (null, new ModuleProblem(EncodingCode, exception.Message));
        }

        (Dictionary<string, (string Value, int Line)> Directives, string Text, ModuleProblem? Problem) header = ReadHeader(source);
        if (header.Problem is not null)
        {
            return (null, header.Problem);
        }

        return ReadManifest(header.Directives, header.Text, Convert.ToHexStringLower(SHA256.HashData(bytes)), bytes.Length);
    }

    /// <summary>
    /// Finds the one custom section of a name in a WebAssembly binary.
    /// </summary>
    private static (int SectionStart, int SectionLength, ModuleProblem? Problem) FindCustomSection(byte[] bytes, string sectionName)
    {
        if (!bytes.AsSpan().StartsWith(Preamble))
        {
            return (0, 0, new ModuleProblem(InvalidCode, "no WebAssembly preamble"));
        }

        byte[] nameBytes = Encoding.UTF8.GetBytes(sectionName);
        int position = Preamble.Length;
        int matchCount = 0;
        int matchStart = 0;
        int matchLength = 0;
        while (position < bytes.Length)
        {
            byte sectionId = bytes[position];
            position += 1;
            if (!TryReadU32(bytes, ref position, out uint sectionByteLength) || sectionByteLength > (uint)(bytes.Length - position))
            {
                return (0, 0, new ModuleProblem(InvalidCode, string.Create(CultureInfo.InvariantCulture, $"section {sectionId} runs past the binary")));
            }

            int sectionEnd = position + (int)sectionByteLength;
            if (sectionId == CustomSectionId)
            {
                int namePosition = position;
                if (!TryReadU32(bytes, ref namePosition, out uint nameByteLength) || nameByteLength > (uint)(sectionEnd - namePosition))
                {
                    return (0, 0, new ModuleProblem(InvalidCode, string.Create(CultureInfo.InvariantCulture, $"custom section name at {position} runs past its section")));
                }

                int payloadStart = namePosition + (int)nameByteLength;
                if (bytes.AsSpan(namePosition, (int)nameByteLength).SequenceEqual(nameBytes))
                {
                    matchCount += 1;
                    matchStart = payloadStart;
                    matchLength = sectionEnd - payloadStart;
                }
            }

            position = sectionEnd;
        }

        return matchCount switch
        {
            0 => (0, 0, new ModuleProblem(SectionMissingCode, sectionName)),
            1 => (matchStart, matchLength, null),
            _ => (0, 0, new ModuleProblem(SectionRepeatedCode, string.Create(CultureInfo.InvariantCulture, $"{sectionName} {matchCount} times")))
        };
    }

    /// <summary>
    /// Reads an unsigned LEB128 of at most five bytes, advancing the position past it.
    /// </summary>
    private static bool TryReadU32(byte[] bytes, ref int position, out uint value)
    {
        value = 0;
        for (int byteIndex = 0; byteIndex < MaximumU32LEB128ByteLength; byteIndex++)
        {
            if (position >= bytes.Length)
            {
                return false;
            }

            byte current = bytes[position];
            position += 1;
            value |= (uint)(current & LEB128PayloadMask) << (byteIndex * LEB128BitsPerByte);
            if ((current & LEB128Continuation) == 0)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Reads the leading <c>//!</c> lines of a decoder source into its directives by name, and the text of those lines; a repeated directive keeps its first value, since the engine judges repeats.
    /// </summary>
    private static (Dictionary<string, (string Value, int Line)> Directives, string Text, ModuleProblem? Problem) ReadHeader(string source)
    {
        Dictionary<string, (string Value, int Line)> directives = new Dictionary<string, (string Value, int Line)>(StringComparer.Ordinal);
        string[] lines = source.Split(LineFeed);
        int headerLineCount = 0;
        for (int lineIndex = 0; lineIndex < lines.Length; lineIndex++)
        {
            // Trimming also drops the carriage return of a CRLF line
            string text = lines[lineIndex].Trim();
            if (!text.StartsWith(HeaderPrefix, StringComparison.Ordinal))
            {
                break;
            }

            int line = lineIndex + 1;
            headerLineCount = line;
            if (text.Length == HeaderPrefix.Length)
            {
                continue;
            }

            Match match = DirectivePattern().Match(text);
            if (!match.Success)
            {
                return (directives, string.Empty, CreateManifestProblem("header-syntax", Quote(text), line));
            }

            directives.TryAdd(match.Groups[1].Value, (match.Groups[2].Value.Trim(), line));
        }

        if (directives.Count == 0)
        {
            return (directives, string.Empty, CreateManifestProblem("header-missing", Quote(lines[0].Trim()), 1));
        }

        string headerText = string.Join(LineFeed, lines.Take(headerLineCount).Select(headerLine => headerLine.TrimEnd(CarriageReturn)));
        return (directives, headerText, null);
    }

    /// <summary>
    /// Reads the directives the plugin offers and shows, checking each the way the engine's manifest parsers do.
    /// </summary>
    private static (DecoderPackageInfo? Package, ModuleProblem? Problem) ReadManifest(
        Dictionary<string, (string Value, int Line)> directives,
        string header,
        string contentHash,
        int byteLength)
    {
        foreach (string required in RequiredDirectives)
        {
            if (!directives.ContainsKey(required))
            {
                return (null, CreateManifestProblem("directive-missing", Quote(required), 1));
            }
        }

        (string idValue, int idLine) = directives[IdDirective];
        if (idValue.Length > MaximumIdLength)
        {
            return (null, CreateManifestProblem("id-length", string.Create(CultureInfo.InvariantCulture, $"{idValue.Length} > {MaximumIdLength}"), idLine));
        }

        if (!TokenPattern().IsMatch(idValue))
        {
            return (null, CreateManifestProblem("id-syntax", Quote(idValue), idLine));
        }

        (string name, int nameLine) = directives[NameDirective];
        if (name.Length == 0)
        {
            return (null, CreateManifestProblem("name-syntax", Quote(name), nameLine));
        }

        (string kind, int kindLine) = directives[DecoderDirective];
        if (kind is not (VideoKind or AudioKind))
        {
            return (null, CreateManifestProblem("decoder-kind", Quote(kind), kindLine));
        }

        (List<string>? codecs, ModuleProblem? acceptsProblem) = ReadAcceptedCodecs(directives[AcceptsDirective], kind);
        if (codecs is null)
        {
            return (null, acceptsProblem);
        }

        if (kind == AudioKind)
        {
            return (new DecoderPackageInfo(idValue, name, kind, codecs, [], false, null, contentHash, byteLength), null);
        }

        if (!directives.TryGetValue(OutputDirective, out (string Value, int Line) output))
        {
            return (null, CreateManifestProblem("directive-missing", Quote(OutputDirective), 1));
        }

        (List<string>? outputFormats, ModuleProblem? outputProblem) = ReadList(output, "output-syntax", "output-duplicate", FormatPattern());
        if (outputFormats is null)
        {
            return (null, outputProblem);
        }

        bool monochrome = false;
        if (directives.TryGetValue(MonochromeDirective, out (string Value, int Line) monochromeDirective))
        {
            if (!string.Equals(monochromeDirective.Value, MonochromeValue, StringComparison.Ordinal))
            {
                return (null, CreateManifestProblem("monochrome-syntax", Quote(monochromeDirective.Value), monochromeDirective.Line));
            }

            monochrome = true;
        }

        return (new DecoderPackageInfo(idValue, name, kind, codecs, outputFormats, monochrome, header, contentHash, byteLength), null);
    }

    /// <summary>
    /// Reads <c>codec in [a, b]</c>, which a video decoder may follow with stream conditions that the engine checks.
    /// </summary>
    private static (List<string>? Codecs, ModuleProblem? Problem) ReadAcceptedCodecs((string Value, int Line) accepts, string kind)
    {
        Match match = AcceptsPattern().Match(accepts.Value);
        if (!match.Success || (kind == AudioKind && match.Groups[2].Success))
        {
            return (null, CreateManifestProblem("accepts-syntax", Quote(accepts.Value), accepts.Line));
        }

        return ReadList((match.Groups[1].Value, accepts.Line), "codec-syntax", "codec-duplicate", TokenPattern());
    }

    /// <summary>
    /// Reads a comma-separated list whose items each match a pattern, once each.
    /// </summary>
    private static (List<string>? Items, ModuleProblem? Problem) ReadList((string Value, int Line) list, string syntaxCode, string duplicateCode, Regex itemPattern)
    {
        List<string> items = [];
        HashSet<string> seenItems = new HashSet<string>(StringComparer.Ordinal);
        foreach (string part in list.Value.Split(ListSeparator))
        {
            string item = part.Trim();
            if (!itemPattern.IsMatch(item))
            {
                return (null, CreateManifestProblem(syntaxCode, Quote(item), list.Line));
            }

            if (!seenItems.Add(item))
            {
                return (null, CreateManifestProblem(duplicateCode, Quote(item), list.Line));
            }

            items.Add(item);
        }

        return (items, null);
    }

    private static ModuleProblem CreateManifestProblem(string check, string detail, int line)
    {
        return new ModuleProblem(ManifestCode, string.Create(CultureInfo.InvariantCulture, $"{check}: {detail} (line {line})"));
    }

    private static string Quote(string text) => "'" + text + "'";

    [GeneratedRegex(@"^//!\s*([A-Za-z]+(?:-[A-Za-z]+)*)\s*:(.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex DirectivePattern();

    // Package ids and codec names: lowercase ASCII letters and digits, in runs joined by single hyphens
    [GeneratedRegex(@"^[a-z0-9]+(?:-[a-z0-9]+)*$", RegexOptions.CultureInvariant)]
    private static partial Regex TokenPattern();

    [GeneratedRegex(@"^codec\s+in\s+\[([^\]]*)\]\s*(?:,(.*))?$", RegexOptions.CultureInvariant)]
    private static partial Regex AcceptsPattern();

    // Output format names, such as I420P10; the engine knows which it supports
    [GeneratedRegex(@"^[A-Za-z0-9]+$", RegexOptions.CultureInvariant)]
    private static partial Regex FormatPattern();
}
