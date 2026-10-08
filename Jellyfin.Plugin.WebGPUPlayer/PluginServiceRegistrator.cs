using Jellyfin.Plugin.WebGPUPlayer.Transformations;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.WebGPUPlayer;

/// <summary>
/// Registers the plugin's services with the server.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // The registrar picks File Transformation or the fallback middleware; the middleware is always installed and stays inert unless picked
        serviceCollection.AddHostedService<FileTransformationRegistrar>();
        serviceCollection.AddTransient<IStartupFilter, WebClientRewriteStartupFilter>();
    }
}
