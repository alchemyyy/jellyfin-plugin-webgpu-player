using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.WebGPUPlayer;

/// <summary>
/// The WebGPU Player plugin.
/// The client add-on keeps the player's preferences per browser; the plugin's settings page manages the decoder packages and pass files the server offers, which the module store keeps in the plugin's data folder.
/// </summary>
/// <remarks>
/// The empty configuration base is still required: only it records the assembly path and version, which the server dereferences when it creates and lists plugins.
/// </remarks>
public class Plugin : BasePlugin<BasePluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// The settings page's name, which its dashboard route names.
    /// </summary>
    public const string ConfigurationPageName = "WebGPUPlayer";

    /// <summary>
    /// The settings page controller's name, which the page's <c>data-controller</c> names.
    /// </summary>
    public const string ConfigurationScriptName = "WebGPUPlayerConfig.js";

    // Embedded resource names of the settings page, set in the project file
    private const string ConfigurationPageResource = "Jellyfin.Plugin.WebGPUPlayer.Configuration.configPage.html";
    private const string ConfigurationScriptResource = "Jellyfin.Plugin.WebGPUPlayer.Configuration.configPage.js";

    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">The server's application paths.</param>
    /// <param name="xmlSerializer">The server's XML serializer.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <inheritdoc />
    public override string Name => "WebGPU Player";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("8f79872d-a0a6-4b96-b5e4-2042079007ac");

    /// <inheritdoc />
    public override string Description => "WebGPU and WebCodecs video player for Jellyfin Web.";

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// Gets the settings page, first, and its controller; the dashboard links a plugin's first page from its plugin list.
    /// </summary>
    /// <returns>The pages.</returns>
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return
        [
            new PluginPageInfo { Name = ConfigurationPageName, EmbeddedResourcePath = ConfigurationPageResource },
            new PluginPageInfo { Name = ConfigurationScriptName, EmbeddedResourcePath = ConfigurationScriptResource }
        ];
    }
}
