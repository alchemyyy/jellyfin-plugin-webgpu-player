using System.Collections.Generic;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// Every decoder package and pass file the store holds, for the plugin's settings page.
/// </summary>
/// <param name="DecoderPackages">The bundled packages, then the uploaded ones.</param>
/// <param name="Passes">The bundled pass files, then the uploaded ones.</param>
public sealed record ModuleListing(
    IReadOnlyList<ModuleListingEntry<DecoderPackageInfo>> DecoderPackages,
    IReadOnlyList<ModuleListingEntry<PassFileInfo>> Passes);
