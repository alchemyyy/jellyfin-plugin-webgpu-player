namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// One module file the store holds, with whether clients get it.
/// </summary>
/// <typeparam name="TInfo">What the file declares.</typeparam>
/// <param name="Key">The identity an upload replaces and a state change names: a package's id, or a pass file's name.</param>
/// <param name="FileName">The file's name.</param>
/// <param name="Source"><c>bundled</c> for a file the plugin carries, <c>uploaded</c> for one an administrator added.</param>
/// <param name="Enabled">Whether the key is enabled.</param>
/// <param name="Offered">Whether clients get this file: its key is enabled, no upload replaces it, and it reads.</param>
/// <param name="Replaced">Whether an upload of its key replaces this bundled file.</param>
/// <param name="Info">What the file declares, or <c>null</c> when it does not read.</param>
/// <param name="Problem">Why the file does not read, or <c>null</c>.</param>
public sealed record ModuleListingEntry<TInfo>(
    string Key,
    string FileName,
    string Source,
    bool Enabled,
    bool Offered,
    bool Replaced,
    TInfo? Info,
    string? Problem)
    where TInfo : class;
