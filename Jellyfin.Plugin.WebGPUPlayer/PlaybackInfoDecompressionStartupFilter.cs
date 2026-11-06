using System;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.WebGPUPlayer;

/// <summary>
/// Installs <see cref="PlaybackInfoDecompressionMiddleware"/> ahead of Jellyfin's pipeline, so its PlaybackInfo route reads decompressed JSON.
/// </summary>
public sealed class PlaybackInfoDecompressionStartupFilter : IStartupFilter
{
    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return application =>
        {
            application.UseMiddleware<PlaybackInfoDecompressionMiddleware>();
            next(application);
        };
    }
}
