using System;
using Jellyfin.Plugin.WebGPUPlayer.Diagnostics;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class ReportFunctionsTests
{
    [Theory]
    [InlineData("native-audio", true)]
    [InlineData(" !~", true)]
    [InlineData("", false)]
    [InlineData("tab\there", false)]
    [InlineData("del\u007f", false)]
    [InlineData("caf\u00e9", false)]
    public void IsPrintableAscii_ChecksEveryCharacter(string value, bool expected)
    {
        Assert.Equal(expected, ReportFunctions.IsPrintableAscii(value, 64));
    }

    [Fact]
    public void IsPrintableAscii_LongerThanTheLimit_IsRefused()
    {
        Assert.True(ReportFunctions.IsPrintableAscii(new string('a', 4), 4));
        Assert.False(ReportFunctions.IsPrintableAscii(new string('a', 5), 4));
    }

    [Fact]
    public void ReadReporter_JellyfinHeader_ReadsOnlyTheClientParts()
    {
        ClientReporter reporter = ReportFunctions.ReadReporter(
            "Safari",
            "MediaBrowser Client=\"Jellyfin Web\", Device=\"Mary%E2%80%99s%20iPhone\", DeviceId=\"device-id\", Version=\"10.11.2\", Token=\"token\"",
            null);

        Assert.Equal(new ClientReporter("Jellyfin Web", "10.11.2", "Mary\u2019s iPhone", "Safari"), reporter);
    }

    [Fact]
    public void ReadReporter_EmbyScheme_IsRead()
    {
        ClientReporter reporter = ReportFunctions.ReadReporter(null, null, "Emby Client=\"Jellyfin Android\", Device=\"Pixel\", Version=\"2.6.0\"");

        Assert.Equal(new ClientReporter("Jellyfin Android", "2.6.0", "Pixel", ReportFunctions.Unknown), reporter);
    }

    [Fact]
    public void ReadReporter_EachPart_ComesFromTheFirstHeaderThatNamesIt()
    {
        ClientReporter reporter = ReportFunctions.ReadReporter(
            null,
            "MediaBrowser Client=\"Jellyfin Web\", Token=\"token\"",
            "MediaBrowser Client=\"Other\", Device=\"Safari\", Version=\"10.11.2\"");

        Assert.Equal(new ClientReporter("Jellyfin Web", "10.11.2", "Safari", ReportFunctions.Unknown), reporter);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Bearer token")]
    [InlineData("MediaBrowser")]
    [InlineData("MediaBrowser Token=\"token\"")]
    [InlineData("MediaBrowser Client=\"\", Device=\"%0A\", Version")]
    public void ReadReporter_HeaderWithoutClientParts_IsUnknown(string? authorization)
    {
        ClientReporter reporter = ReportFunctions.ReadReporter(null, authorization, null);

        Assert.Equal(new ClientReporter(ReportFunctions.Unknown, ReportFunctions.Unknown, ReportFunctions.Unknown, ReportFunctions.Unknown), reporter);
    }

    [Fact]
    public void ReadReporter_ForgedLines_AreDroppedAndLongValuesCut()
    {
        ClientReporter reporter = ReportFunctions.ReadReporter(
            "Safari\r\n[ERR] forged\u202E" + new string('a', ReportFunctions.MaximumUserAgentLength),
            "MediaBrowser Device=\"Safari%0D%0A%5BERR%5D%20forged\", Client=\"" + new string('c', ReportFunctions.MaximumClientFieldLength + 1) + "\"",
            null);

        Assert.DoesNotContain('\r', reporter.UserAgent);
        Assert.DoesNotContain('\n', reporter.UserAgent);
        Assert.DoesNotContain('\u202E', reporter.UserAgent);
        Assert.StartsWith("Safari[ERR] forged", reporter.UserAgent, StringComparison.Ordinal);
        Assert.Equal(ReportFunctions.MaximumUserAgentLength, reporter.UserAgent.Length);
        Assert.Equal("Safari[ERR] forged", reporter.Device);
        Assert.Equal(new string('c', ReportFunctions.MaximumClientFieldLength), reporter.Client);
    }
}
