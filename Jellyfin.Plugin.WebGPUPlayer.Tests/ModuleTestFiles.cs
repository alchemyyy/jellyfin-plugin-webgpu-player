using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

/// <summary>
/// Builds the decoder packages and pass files the module tests read: WebAssembly modules with custom sections, and pass sources.
/// </summary>
internal static class ModuleTestFiles
{
    // The section the engine's package format names, which the add-on manifest relays
    public const string DecoderSection = "webgpu-player.decoder";

    public const string HEVCId = "hevc";
    public const string HEVCName = "HEVC";
    public const string EAC3Id = "eac3";
    public const string EAC3Name = "E-AC-3";
    public const string SharpenFileName = "sharpen.wgsl";
    public const string SharpenPassName = "Sharpen";

    public const string VideoHeader =
        "//! id: hevc\n"
        + "//! name: HEVC\n"
        + "//! decoder: video\n"
        + "//! accepts: codec in [hevc], stream.width <= 8192, stream.height <= 4320\n"
        + "//! output: I420, I420P10\n"
        + "//! monochrome: yes\n"
        + "//! packet: 1 MiB\n"
        + "//! dispatch: main, 1\n"
        + "\n"
        + "@compute @workgroup_size(1) fn main() {}\n";

    public const string AudioHeader =
        "//! id: eac3\n"
        + "//! name: E-AC-3\n"
        + "//! decoder: audio\n"
        + "//! accepts: codec in [eac3, ac3]\n"
        + "//! packet: 2 MiB\n";

    public const string SharpenSource =
        "//! name: Sharpen\n"
        + "//! shape: kernel\n"
        + "//! hook: OUTPUT\n"
        + "\n"
        + "fn kernel(coordinate: vec2f) -> vec4f { return HOOKED_tex(coordinate); }\n";

    private const byte CustomSectionId = 0;
    private const byte TypeSectionId = 1;
    private const int LEB128PayloadMask = 0x7F;
    private const int LEB128Continuation = 0x80;
    private const int LEB128BitsPerByte = 7;

    // The WebAssembly preamble: the magic and binary version 1
    private static readonly byte[] Preamble = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];

    // An empty type section, so the custom sections are not the module's only ones
    private static readonly byte[] EmptyTypeSection = [TypeSectionId, 0x01, 0x00];

    /// <summary>Returns a module of the custom sections in order, after an empty type section.</summary>
    public static byte[] CreateModule(params (string Name, byte[] Payload)[] customSections)
    {
        using MemoryStream module = new MemoryStream();
        module.Write(Preamble);
        module.Write(EmptyTypeSection);
        foreach ((string name, byte[] payload) in customSections)
        {
            byte[] nameBytes = Encoding.UTF8.GetBytes(name);
            List<byte> content = [.. EncodeU32((uint)nameBytes.Length), .. nameBytes, .. payload];
            module.WriteByte(CustomSectionId);
            module.Write(EncodeU32((uint)content.Count));
            module.Write([.. content]);
        }

        return module.ToArray();
    }

    /// <summary>Returns a package whose decoder section holds the header text.</summary>
    public static byte[] CreatePackage(string header)
    {
        return CreateModule((DecoderSection, Encoding.UTF8.GetBytes(header)));
    }

    /// <summary>Returns the video header with one directive line replaced, or removed when the replacement is empty.</summary>
    public static string ReplaceVideoHeaderLine(string directive, string replacement)
    {
        StringBuilder header = new StringBuilder();
        foreach (string line in VideoHeader.Split('\n'))
        {
            if (line.StartsWith("//! " + directive + ":", System.StringComparison.Ordinal))
            {
                if (replacement.Length > 0)
                {
                    header.Append(replacement).Append('\n');
                }

                continue;
            }

            header.Append(line).Append('\n');
        }

        return header.ToString();
    }

    private static byte[] EncodeU32(uint value)
    {
        List<byte> bytes = [];
        uint remaining = value;
        do
        {
            byte current = (byte)(remaining & LEB128PayloadMask);
            remaining >>= LEB128BitsPerByte;
            if (remaining > 0)
            {
                current |= LEB128Continuation;
            }

            bytes.Add(current);
        }
        while (remaining > 0);
        return [.. bytes];
    }
}
