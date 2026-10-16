namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// Why the plugin refuses a module file or cannot offer one: the failed check, then a terse detail with the failing value.
/// </summary>
/// <param name="Code">The failed check, such as <c>package-section-missing</c>.</param>
/// <param name="Detail">The failing value.</param>
public sealed record ModuleProblem(string Code, string Detail)
{
    /// <summary>
    /// The code of a request for a module the store does not hold.
    /// </summary>
    public const string UnknownModuleCode = "module-unknown";

    /// <summary>
    /// The code of a module file or state change the data folder refused.
    /// </summary>
    public const string WriteFailedCode = "module-write-failed";

    /// <summary>
    /// The code of an upload larger than its kind allows.
    /// </summary>
    public const string SizeCode = "module-size";

    /// <inheritdoc />
    public override string ToString() => Code + ": " + Detail;
}
