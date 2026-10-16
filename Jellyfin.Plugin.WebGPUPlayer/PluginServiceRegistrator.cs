using System;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using Jellyfin.Plugin.WebGPUPlayer.Transformations;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

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

        // NOTE: The server registers services before it creates plugins, so the store opens at its first request, once the plugin knows its data folder
        serviceCollection.AddSingleton(provider => ModuleStore.OpenBundled(
            Plugin.Instance?.DataFolderPath ?? throw new InvalidOperationException("The WebGPU Player plugin is not created"),
            provider.GetRequiredService<ILogger<ModuleStore>>()));
    }
}
