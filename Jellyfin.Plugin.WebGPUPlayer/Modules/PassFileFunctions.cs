using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// Stateless rules for reading pass files: WGSL sources whose passes each start with a <c>//!</c> header.
/// The plugin reads only the pass names it shows; a client's engine checks every header when it applies the file.
/// </summary>
public static partial class PassFileFunctions
{
    /// <summary>
    /// The file extension of pass files.
    /// </summary>
    public const string FileExtension = ".wgsl";

    /// <summary>
    /// The content type the plugin serves pass files with.
    /// </summary>
    public const string ContentType = "text/plain; charset=utf-8";

    /// <summary>
    /// The largest pass file the plugin accepts, the client's limit on a stored source; the largest bundled one is about 330 KB.
    /// </summary>
    public const int MaximumByteLength = 16 * 1024 * 1024;

    // The failed checks
    private const string FileNameCode = "pass-file-name";
    private const string SizeCode = "pass-size";
    private const string EncodingCode = "pass-encoding";
    private const string EmptyCode = "pass-empty";
    private const string NullCharacterCode = "pass-null-character";
    private const string HeaderMissingCode = "pass-header-missing";

    private const int MaximumFileNameLength = 128;
    private const char NullCharacter = '\0';
    private const char ByteOrderMark = '﻿';
    private const char LineFeed = '\n';

    private static readonly UTF8Encoding StrictUTF8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    /// <summary>
    /// Checks a pass file's name, which identifies it, names its stored file, and is a segment of its route.
    /// </summary>
    /// <param name="fileName">The file name.</param>
    /// <returns>The failed check, or <c>null</c> for a usable name.</returns>
    public static ModuleProblem? FindFileNameProblem(string? fileName)
    {
        if (string.IsNullOrEmpty(fileName))
        {
            return new ModuleProblem(FileNameCode, "''");
        }

        if (fileName.Length > MaximumFileNameLength)
        {
            return new ModuleProblem(FileNameCode, string.Create(CultureInfo.InvariantCulture, $"{fileName.Length} > {MaximumFileNameLength}"));
        }

        return FileNamePattern().IsMatch(fileName) && fileName.EndsWith(FileExtension, StringComparison.OrdinalIgnoreCase)
            ? null
            : new ModuleProblem(FileNameCode, "'" + fileName + "'");
    }

    /// <summary>
    /// Reads a pass file's pass names.
    /// </summary>
    /// <param name="fileName">The file's name.</param>
    /// <param name="bytes">The file.</param>
    /// <returns>What the file declares, or the check it failed.</returns>
    public static (PassFileInfo? File, ModuleProblem? Problem) ReadPassFile(string fileName, byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        ModuleProblem? fileNameProblem = FindFileNameProblem(fileName);
        if (fileNameProblem is not null)
        {
            return (null, fileNameProblem);
        }

        if (bytes.Length > MaximumByteLength)
        {
            return (null, new ModuleProblem(SizeCode, string.Create(CultureInfo.InvariantCulture, $"{bytes.Length} > {MaximumByteLength}")));
        }

        string source;
        try
        {
            source = StrictUTF8.GetString(bytes).TrimStart(ByteOrderMark);
        }
        catch (DecoderFallbackException exception)
        {
            return (null, new ModuleProblem(EncodingCode, exception.Message));
        }

        if (string.IsNullOrWhiteSpace(source))
        {
            return (null, new ModuleProblem(EmptyCode, fileName));
        }

        int nullIndex = source.IndexOf(NullCharacter, StringComparison.Ordinal);
        if (nullIndex >= 0)
        {
            return (null, new ModuleProblem(NullCharacterCode, string.Create(CultureInfo.InvariantCulture, $"at {nullIndex}")));
        }

        List<string> passNames = [];
        foreach (string line in source.Split(LineFeed))
        {
            Match match = NameDirectivePattern().Match(line.Trim());
            if (match.Success)
            {
                passNames.Add(match.Groups[1].Value.Trim());
            }
        }

        return passNames.Count == 0
            ? (null, new ModuleProblem(HeaderMissingCode, "no '//! name:' line"))
            : (new PassFileInfo(fileName, passNames, Convert.ToHexStringLower(SHA256.HashData(bytes)), bytes.Length), null);
    }

    // ASCII letters, digits, dots, underscores, and hyphens, starting with a letter or digit, so a name is safe as a file name and a route segment
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex FileNamePattern();

    [GeneratedRegex(@"^//!\s*name\s*:(.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex NameDirectivePattern();
}
