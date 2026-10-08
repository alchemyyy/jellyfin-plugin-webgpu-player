using Jellyfin.Plugin.WebGPUPlayer.Addon;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// File Transformation callbacks. File Transformation resolves each method by name, so names must stay unique on this type.
/// </summary>
public static class TransformationCallbacks
{
    /// <summary>
    /// Injects the bootstrap script into <c>index.html</c>.
    /// </summary>
    /// <param name="payload">The served file.</param>
    /// <returns>The complete new text, or the original text when no add-on is embedded or the plugin has no instance.</returns>
    public static string? TransformIndexHTML(TransformationPayload? payload)
    {
        string? contents = payload?.Contents;
        if (contents is null || Plugin.Instance is null)
        {
            return contents;
        }

        return WebClientFunctions.InjectBootstrapScript(contents, AddonCatalog.Entry);
    }

    /// <summary>
    /// Appends the add-on to the <c>plugins</c> list of <c>config.json</c>.
    /// </summary>
    /// <param name="payload">The served file.</param>
    /// <returns>The complete new text, or the original text whenever <see cref="TransformIndexHTML"/> would not inject, because a listed plugin without its window factory fails to load.</returns>
    public static string? TransformConfigJSON(TransformationPayload? payload)
    {
        string? contents = payload?.Contents;
        if (contents is null || AddonCatalog.Entry is null || Plugin.Instance is null)
        {
            return contents;
        }

        return WebClientFunctions.AddPluginToConfig(contents);
    }
}
