namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// Why the plugin refuses a client's diagnostics report: the failed check, which the report's route names, then a terse detail.
/// </summary>
/// <param name="Code">The failed check.</param>
/// <param name="Detail">The failing part of the report.</param>
public sealed record ReportProblem(string Code, string Detail)
{
    /// <inheritdoc />
    public override string ToString() => Code + ": " + Detail;
}
