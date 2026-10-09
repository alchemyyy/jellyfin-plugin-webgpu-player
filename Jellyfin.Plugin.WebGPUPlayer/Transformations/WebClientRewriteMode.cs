namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// Which component rewrites the Jellyfin Web files.
/// At most one of them runs, so a file is never rewritten twice.
/// </summary>
public enum WebClientRewriteMode
{
    /// <summary>
    /// The server is still starting and the registrar has not decided yet.
    /// </summary>
    Undecided,

    /// <summary>
    /// File Transformation runs the registered callbacks.
    /// </summary>
    FileTransformation,

    /// <summary>
    /// The plugin's own middleware rewrites the files, because File Transformation is absent or rejected the registration.
    /// </summary>
    Middleware,

    /// <summary>
    /// Nothing is rewritten, because no client add-on is embedded.
    /// </summary>
    Disabled,
}
