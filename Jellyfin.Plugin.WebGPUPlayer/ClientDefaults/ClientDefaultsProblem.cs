namespace Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;

/// <summary>
/// Why the plugin refuses an administrator's client defaults or cannot store them: the failed check, then a terse detail with the failing value.
/// </summary>
/// <param name="Code">The failed check.</param>
/// <param name="Detail">The failing value.</param>
public sealed record ClientDefaultsProblem(string Code, string Detail)
{
    /// <summary>
    /// The code of a document whose shape the store refuses.
    /// </summary>
    public const string InvalidCode = "client-defaults-invalid";

    /// <summary>
    /// The code of a document larger than <see cref="ClientDefaultsFunctions.MaximumByteLength"/>.
    /// </summary>
    public const string SizeCode = "client-defaults-size";

    /// <summary>
    /// The code of a document the data folder refused.
    /// </summary>
    public const string WriteFailedCode = "client-defaults-write-failed";

    /// <inheritdoc />
    public override string ToString() => Code + ": " + Detail;
}
