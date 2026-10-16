using System.Collections.Generic;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// What a pass file declares that the plugin offers and shows, with the file's content hash and size.
/// </summary>
/// <param name="FileName">The file's name, which identifies it.</param>
/// <param name="PassNames">The names its pass headers declare, in file order.</param>
/// <param name="ContentHash">The lowercase hexadecimal SHA-256 of the file, which tells its versions apart.</param>
/// <param name="ByteLength">The file's size in bytes.</param>
public sealed record PassFileInfo(
    string FileName,
    IReadOnlyList<string> PassNames,
    string ContentHash,
    int ByteLength);
