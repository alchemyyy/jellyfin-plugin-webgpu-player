using System.Collections.Generic;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// What a decoder package's header declares that the plugin offers and shows, with the file's content hash and size.
/// </summary>
/// <param name="Id">The id the header declares, which every version of the package keeps.</param>
/// <param name="Name">The name the header declares.</param>
/// <param name="Kind">The decoder kind, <c>video</c> or <c>audio</c>.</param>
/// <param name="Codecs">The codecs its <c>accepts</c> line takes, by the engine's names.</param>
/// <param name="OutputFormats">The planar formats a video decoder writes; an audio decoder has none.</param>
/// <param name="Monochrome">Whether a video decoder takes 4:0:0 streams.</param>
/// <param name="ContentHash">The lowercase hexadecimal SHA-256 of the file, which tells its versions apart as the engine's own hash does.</param>
/// <param name="ByteLength">The file's size in bytes.</param>
public sealed record DecoderPackageInfo(
    string Id,
    string Name,
    string Kind,
    IReadOnlyList<string> Codecs,
    IReadOnlyList<string> OutputFormats,
    bool Monochrome,
    string ContentHash,
    int ByteLength);
