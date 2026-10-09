using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.Addon;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// Decides at server start which component rewrites Jellyfin Web: File Transformation when it is installed and accepts the callbacks, otherwise the plugin's own <see cref="WebClientRewriteMiddleware"/>.
/// Never both.
/// </summary>
/// <param name="logger">The logger.</param>
public sealed class FileTransformationRegistrar(ILogger<FileTransformationRegistrar> logger) : IHostedService
{
    /// <summary>
    /// The exact key of the web client page.
    /// File Transformation runs one rule list per file, and exact keys are shared and win over regex keys.
    /// </summary>
    public const string IndexHTMLFileName = "index.html";

    /// <summary>
    /// The exact key of the web client configuration.
    /// </summary>
    public const string ConfigJSONFileName = "config.json";

    private static readonly Guid IndexHTMLTransformationId = new Guid("fedb474b-4b31-47cb-881c-7d9d0efa0e5c");
    private static readonly Guid ConfigJSONTransformationId = new Guid("95db4c47-1e2e-4ef5-808e-bd4a0db1382f");

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        WebClientRewriteMode mode;
        try
        {
            mode = DecideRewriteMode();
        }
        catch (Exception exception)
        {
            // NOTE: An exception that escapes StartAsync aborts server start, so this logs and falls back instead of rethrowing; registration failures are caught before this point
            logger.LogWarning(exception, "WebGPU Player could not set up File Transformation; its own middleware rewrites Jellyfin Web");
            mode = WebClientRewriteMode.Middleware;
        }

        WebClientRewriteState.SetMode(mode);
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }

    private WebClientRewriteMode DecideRewriteMode()
    {
        if (AddonCatalog.Entry is null)
        {
            logger.LogWarning("WebGPU Player client add-on is not embedded ({Problem}); Jellyfin Web stays unmodified", AddonCatalog.Problem);
            return WebClientRewriteMode.Disabled;
        }

        MethodInfo? registerMethod = FileTransformationFunctions.FindRegisterMethod(AssemblyLoadContext.All.SelectMany(context => context.Assemblies));
        if (registerMethod is null)
        {
            logger.LogInformation("File Transformation is not installed; WebGPU Player rewrites index.html and config.json with its own middleware");
            return WebClientRewriteMode.Middleware;
        }

        // NOTE: index.html goes first, because config.json must never name a window factory that index.html does not define
        if (!TryRegisterCallback(registerMethod, IndexHTMLTransformationId, IndexHTMLFileName, nameof(TransformationCallbacks.TransformIndexHTML)))
        {
            logger.LogWarning("File Transformation rejected the WebGPU Player callbacks; WebGPU Player rewrites Jellyfin Web with its own middleware");
            return WebClientRewriteMode.Middleware;
        }

        if (TryRegisterCallback(registerMethod, ConfigJSONTransformationId, ConfigJSONFileName, nameof(TransformationCallbacks.TransformConfigJSON)))
        {
            logger.LogInformation("WebGPU Player rewrites Jellyfin Web through File Transformation");
            return WebClientRewriteMode.FileTransformation;
        }

        // The middleware may take over only once File Transformation stops rewriting index.html
        if (TryRemoveCallback(registerMethod, IndexHTMLTransformationId))
        {
            logger.LogWarning("File Transformation rejected the WebGPU Player config.json callback; WebGPU Player rewrites Jellyfin Web with its own middleware");
            return WebClientRewriteMode.Middleware;
        }

        logger.LogError("WebGPU Player could neither complete nor withdraw its File Transformation registration; Jellyfin Web will not load the player");
        return WebClientRewriteMode.FileTransformation;
    }

    private bool TryRegisterCallback(MethodInfo registerMethod, Guid id, string fileName, string callbackMethod)
    {
        try
        {
            string registrationJSON = FileTransformationFunctions.BuildRegistrationJSON(id, fileName, typeof(TransformationCallbacks), callbackMethod);
            object payload = FileTransformationFunctions.CreatePayload(registerMethod, registrationJSON);
            registerMethod.Invoke(null, [payload]);
            logger.LogInformation("WebGPU Player registered its File Transformation callback for {FileName}", fileName);
            return true;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "File Transformation rejected the WebGPU Player callback for {FileName}", fileName);
            return false;
        }
    }

    private bool TryRemoveCallback(MethodInfo registerMethod, Guid id)
    {
        MethodInfo? removeMethod = FileTransformationFunctions.FindRemoveMethod(registerMethod);
        if (removeMethod is null)
        {
            return false;
        }

        try
        {
            removeMethod.Invoke(null, [id]);
            return true;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "File Transformation could not remove the WebGPU Player callback {Id}", id);
            return false;
        }
    }
}
