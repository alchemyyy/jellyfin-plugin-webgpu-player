using System.Collections.Generic;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// The module store's state file: the keys an administrator disabled.
/// </summary>
/// <param name="Version">The state format; a file of another version loads as no disabled keys.</param>
/// <param name="DisabledDecoderPackages">The disabled package ids.</param>
/// <param name="DisabledPasses">The disabled pass file names.</param>
public sealed record ModuleState(
    int Version,
    IReadOnlyList<string> DisabledDecoderPackages,
    IReadOnlyList<string> DisabledPasses);
