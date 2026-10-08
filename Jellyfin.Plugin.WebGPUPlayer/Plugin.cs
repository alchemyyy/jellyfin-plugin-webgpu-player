using System;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.WebGPUPlayer;

/// <summary>
/// The WebGPU Player plugin. It has no server settings: the player's preferences are kept per browser by the client add-on.
/// </summary>
/// <remarks>
/// The empty configuration base is still required: only it records the assembly path and version, which the server dereferences when it creates and lists plugins.
/// </remarks>
public class Plugin : BasePlugin<BasePluginConfiguration>
{
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
}
