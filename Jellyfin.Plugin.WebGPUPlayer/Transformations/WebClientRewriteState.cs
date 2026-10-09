using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Jellyfin.Plugin.WebGPUPlayer.Addon;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// The component that rewrites Jellyfin Web on this server, decided once by <see cref="FileTransformationRegistrar"/>.
/// </summary>
public static class WebClientRewriteState
{
    // Plugin assemblies load before the registrar or the web host starts, so one scan answers for the process lifetime
    private static readonly Lazy<MethodInfo?> FileTransformationScan = new Lazy<MethodInfo?>(
        () => FileTransformationFunctions.FindRegisterMethod(AssemblyLoadContext.All.SelectMany(context => context.Assemblies)));

    private static volatile WebClientRewriteMode currentMode;

    /// <summary>
    /// Gets the registrar's decision.
    /// </summary>
    public static WebClientRewriteMode Mode => currentMode;

    /// <summary>
    /// Gets the File Transformation registration method, or <c>null</c> when File Transformation is not loaded.
    /// </summary>
    public static MethodInfo? FileTransformationRegisterMethod => FileTransformationScan.Value;

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
    /// <returns><c>true</c> when the registrar picked the middleware, or has not decided yet and is expected to pick it.</returns>
    public static bool IsMiddlewareActive()
    {
        return WebClientRewriteFunctions.IsMiddlewareActive(currentMode, AddonCatalog.Entry is not null, FileTransformationRegisterMethod is not null);
    }
}
