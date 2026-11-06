namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// Why the plugin refuses a client's report of crashed capability probes: the failed check, then a terse detail.
/// </summary>
/// <param name="Code">The failed check.</param>
/// <param name="Detail">The failing part of the report.</param>
public sealed record ProbeCrashProblem(string Code, string Detail)
{
    /// <summary>
    /// The code of a report whose shape or values the plugin refuses.
    /// </summary>
    public const string InvalidCode = "probe-crashes-invalid";

    /// <summary>
    /// The code of a report larger than <see cref="ProbeCrashFunctions.MaximumByteLength"/>.
    /// </summary>
    public const string SizeCode = "probe-crashes-size";

    /// <inheritdoc />
    public override string ToString() => Code + ": " + Detail;
}
