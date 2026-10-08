namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// The Jellyfin Web files the plugin rewrites so that the client add-on loads.
/// </summary>
public enum WebClientFile
{
    /// <summary>
    /// The web client page, which receives the bootstrap script.
    /// </summary>
    IndexHTML,

    /// <summary>
    /// The web client configuration, which lists the add-on as a plugin.
    /// </summary>
    ConfigJSON,
}
