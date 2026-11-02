using System;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

// A clock that tells the Unix time, in milliseconds, a test sets
internal sealed class ManualTimeProvider(long unixTimeMilliseconds) : TimeProvider
{
    public long UnixTimeMilliseconds { get; set; } = unixTimeMilliseconds;

    public override DateTimeOffset GetUtcNow()
    {
        return DateTimeOffset.FromUnixTimeMilliseconds(UnixTimeMilliseconds);
    }
}
