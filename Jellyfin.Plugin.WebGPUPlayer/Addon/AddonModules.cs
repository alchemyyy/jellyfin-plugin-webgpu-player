using System.Collections.Generic;

namespace Jellyfin.Plugin.WebGPUPlayer.Addon;

/// <summary>
/// The engine modules the add-on build carries for the plugin to offer: decoder packages and pass files, by their paths in the add-on.
/// </summary>
/// <param name="DecoderPackageSection">The custom section that carries a decoder package's header, as the engine's package format names it, or <c>null</c> when the manifest names none.</param>
/// <param name="DecoderPackagePaths">The embedded decoder packages, in manifest order.</param>
/// <param name="PassPaths">The embedded pass files, in manifest order.</param>
/// <param name="Problem">What the manifest lacked or listed wrongly, or <c>null</c>.</param>
public sealed record AddonModules(
    string? DecoderPackageSection,
    IReadOnlyList<string> DecoderPackagePaths,
    IReadOnlyList<string> PassPaths,
    string? Problem);
