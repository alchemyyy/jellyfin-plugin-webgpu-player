using System.Collections.Generic;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// The decoder packages and pass files clients get.
/// </summary>
/// <param name="DecoderPackages">The offered packages.</param>
/// <param name="Passes">The offered pass files.</param>
public sealed record ModuleCatalog(
    IReadOnlyList<DecoderPackageInfo> DecoderPackages,
    IReadOnlyList<PassFileInfo> Passes);
