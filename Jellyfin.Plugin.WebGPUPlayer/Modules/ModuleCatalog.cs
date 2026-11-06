using System.Collections.Generic;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// The decoder packages and pass files clients get.
/// </summary>
/// <param name="DecoderPackages">The offered packages.</param>
/// <param name="Passes">The offered pass files.</param>
public sealed record ModuleCatalog(
    IReadOnlyList<DecoderPackageInfo> DecoderPackages,
    IReadOnlyList<PassFileInfo> Passes)
{
    /// <summary>
    /// Gets the entry module path of the add-on build the server's pages load now, which a page that loaded another build compares to reload itself between plays.
    /// </summary>
    public string? AddonEntry { get; init; }
}
