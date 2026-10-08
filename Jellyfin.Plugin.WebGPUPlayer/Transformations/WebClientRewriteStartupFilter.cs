using System;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// Installs <see cref="WebClientRewriteMiddleware"/> ahead of Jellyfin's pipeline, the same way File Transformation installs its own.
/// The middleware stays inert while File Transformation handles this plugin's files.
/// </summary>
/// <param name="configurationManager">The server configuration, read for the base URL on each request.</param>
public sealed class WebClientRewriteStartupFilter(IServerConfigurationManager configurationManager) : IStartupFilter
{
    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            Func<string> getBaseUrl = () => configurationManager.GetNetworkConfiguration().BaseUrl;
            Func<bool> isActive = WebClientRewriteState.IsMiddlewareActive;
            Func<WebClientFile, string, string?> rewrite = WebClientRewriteFunctions.Rewrite;
            app.UseMiddleware<WebClientRewriteMiddleware>(getBaseUrl, isActive, rewrite);
            next(app);
        };
    }
}
