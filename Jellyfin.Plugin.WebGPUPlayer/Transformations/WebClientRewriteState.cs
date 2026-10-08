using System;
using System.Linq;
using System.Runtime.Loader;
using Jellyfin.Plugin.WebGPUPlayer.Addon;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// The component that rewrites Jellyfin Web on this server, decided once by <see cref="FileTransformationRegistrar"/>.
/// </summary>
public static class WebClientRewriteState
{
    // Plugin assemblies load before the web host starts, so one scan answers for the process lifetime
    private static readonly Lazy<bool> FileTransformationLoaded = new Lazy<bool>(
        () => FileTransformationFunctions.FindRegisterMethod(AssemblyLoadContext.All.SelectMany(context => context.Assemblies)) is not null);

    private static volatile WebClientRewriteMode currentMode;

    /// <summary>
    /// Gets the registrar's decision.
    /// </summary>
    public static WebClientRewriteMode Mode => currentMode;

    /// <summary>
    /// Records the registrar's decision.
    /// </summary>
    /// <param name="mode">The component that rewrites Jellyfin Web.</param>
    public static void SetMode(WebClientRewriteMode mode)
    {
        currentMode = mode;
    }

    /// <summary>
    /// Returns whether the plugin's middleware rewrites the current request.
    /// </summary>
    /// <returns><c>true</c> when File Transformation does not handle this plugin's files.</returns>
    public static bool IsMiddlewareActive()
    {
        return WebClientRewriteFunctions.IsMiddlewareActive(currentMode, AddonCatalog.Entry is not null, FileTransformationLoaded.Value);
    }
}
