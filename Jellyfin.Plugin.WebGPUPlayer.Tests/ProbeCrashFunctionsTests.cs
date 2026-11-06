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

        (IReadOnlyList<ProbeCrash>? crashes, ReportProblem? problem) = ProbeCrashFunctions.ReadReport(report);

        Assert.Null(problem);
        Assert.NotNull(crashes);
        Assert.Equal(2, crashes.Count);
        Assert.Equal("native-audio", crashes[0].Probe);
        Assert.Equal(["decode aac"], crashes[0].Steps);
        Assert.Equal("vp9", crashes[1].Probe);
        Assert.Empty(crashes[1].Steps);
    }

    [Fact]
    public void FormatSteps_JoinsTheStepsOrNamesNone()
    {
        Assert.Equal("check mp4a.40.2, decode aac", ProbeCrashFunctions.FormatSteps(["check mp4a.40.2", "decode aac"]));
        Assert.Equal(ProbeCrashFunctions.NoSteps, ProbeCrashFunctions.FormatSteps([]));
    }
}
