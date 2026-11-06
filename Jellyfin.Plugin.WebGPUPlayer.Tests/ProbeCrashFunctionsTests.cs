using System;
using System.Collections.Generic;
using System.Text;
using Jellyfin.Plugin.WebGPUPlayer.Diagnostics;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class ProbeCrashFunctionsTests
{
    [Fact]
    public void ReadReport_ValidReport_ReadsEveryCrashInOrder()
    {
        byte[] report = Encoding.UTF8.GetBytes("""{ "crashes": [ { "probe": "native-audio", "steps": ["decode aac"] }, { "steps": [], "probe": "vp9" } ] }""");

        (IReadOnlyList<ProbeCrash>? crashes, ProbeCrashProblem? problem) = ProbeCrashFunctions.ReadReport(report);

        Assert.Null(problem);
        Assert.NotNull(crashes);
        Assert.Equal(2, crashes.Count);
        Assert.Equal("native-audio", crashes[0].Probe);
        Assert.Equal(["decode aac"], crashes[0].Steps);
        Assert.Equal("vp9", crashes[1].Probe);
        Assert.Empty(crashes[1].Steps);
    }

    [Theory]
    [InlineData("native-audio", true)]
    [InlineData(" !~", true)]
    [InlineData("", false)]
    [InlineData("tab\there", false)]
    [InlineData("del\u007f", false)]
    [InlineData("caf\u00e9", false)]
    public void IsPrintableAscii_ChecksEveryCharacter(string value, bool expected)
    {
        Assert.Equal(expected, ProbeCrashFunctions.IsPrintableAscii(value, 64));
    }

    [Fact]
    public void IsPrintableAscii_LongerThanTheLimit_IsRefused()
    {
        Assert.True(ProbeCrashFunctions.IsPrintableAscii(new string('a', 4), 4));
        Assert.False(ProbeCrashFunctions.IsPrintableAscii(new string('a', 5), 4));
    }

    [Fact]
    public void ReadReporter_JellyfinHeader_ReadsOnlyTheClientParts()
    {
        ProbeCrashReporter reporter = ProbeCrashFunctions.ReadReporter(
            "Safari",
            "MediaBrowser Client=\"Jellyfin Web\", Device=\"Mary%E2%80%99s%20iPhone\", DeviceId=\"device-id\", Version=\"10.11.2\", Token=\"token\"",
            null);

        Assert.Equal(new ProbeCrashReporter("Jellyfin Web", "10.11.2", "Mary\u2019s iPhone", "Safari"), reporter);
    }

    [Fact]
    public void ReadReporter_EmbyScheme_IsRead()
    {
        ProbeCrashReporter reporter = ProbeCrashFunctions.ReadReporter(null, null, "Emby Client=\"Jellyfin Android\", Device=\"Pixel\", Version=\"2.6.0\"");

        Assert.Equal(new ProbeCrashReporter("Jellyfin Android", "2.6.0", "Pixel", ProbeCrashFunctions.Unknown), reporter);
    }

    [Fact]
    public void ReadReporter_EachPart_ComesFromTheFirstHeaderThatNamesIt()
    {
        ProbeCrashReporter reporter = ProbeCrashFunctions.ReadReporter(
            null,
            "MediaBrowser Client=\"Jellyfin Web\", Token=\"token\"",
            "MediaBrowser Client=\"Other\", Device=\"Safari\", Version=\"10.11.2\"");

        Assert.Equal(new ProbeCrashReporter("Jellyfin Web", "10.11.2", "Safari", ProbeCrashFunctions.Unknown), reporter);
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
        ProbeCrashReporter reporter = ProbeCrashFunctions.ReadReporter(null, authorization, null);

        Assert.Equal(new ProbeCrashReporter(ProbeCrashFunctions.Unknown, ProbeCrashFunctions.Unknown, ProbeCrashFunctions.Unknown, ProbeCrashFunctions.Unknown), reporter);
    }

    [Fact]
    public void ReadReporter_ForgedLines_AreDroppedAndLongValuesCut()
    {
        ProbeCrashReporter reporter = ProbeCrashFunctions.ReadReporter(
            "Safari\r\n[ERR] forged\u202E" + new string('a', ProbeCrashFunctions.MaximumUserAgentLength),
            "MediaBrowser Device=\"Safari%0D%0A%5BERR%5D%20forged\", Client=\"" + new string('c', ProbeCrashFunctions.MaximumClientFieldLength + 1) + "\"",
            null);

        Assert.DoesNotContain('\r', reporter.UserAgent);
        Assert.DoesNotContain('\n', reporter.UserAgent);
        Assert.DoesNotContain('\u202E', reporter.UserAgent);
        Assert.StartsWith("Safari[ERR] forged", reporter.UserAgent, StringComparison.Ordinal);
        Assert.Equal(ProbeCrashFunctions.MaximumUserAgentLength, reporter.UserAgent.Length);
        Assert.Equal("Safari[ERR] forged", reporter.Device);
        Assert.Equal(new string('c', ProbeCrashFunctions.MaximumClientFieldLength), reporter.Client);
    }

    [Fact]
    public void FormatSteps_JoinsTheStepsOrNamesNone()
    {
        Assert.Equal("check mp4a.40.2, decode aac", ProbeCrashFunctions.FormatSteps(["check mp4a.40.2", "decode aac"]));
        Assert.Equal(ProbeCrashFunctions.NoSteps, ProbeCrashFunctions.FormatSteps([]));
    }
}
