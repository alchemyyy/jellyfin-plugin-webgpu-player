using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.Diagnostics;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xunit;
using static Jellyfin.Plugin.WebGPUPlayer.Tests.RoleHeaderTestServer;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class DiagnosticsControllerTests
{
    private const string ProbeCrashesPath = "/" + ModuleController.RoutePrefix + "/Diagnostics/ProbeCrashes";
    private const string PlaybackFallbacksPath = "/" + ModuleController.RoutePrefix + "/Diagnostics/PlaybackFallbacks";
    private const string JsonContentType = "application/json";
    private const string SafariUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
    private const string Token = "secret-token-0123456789";
    private const string DeviceId = "secret-device-id-0123456789";
    private const string ClientAuthorization = "MediaBrowser Client=\"Jellyfin Web\", Device=\"Safari\", DeviceId=\"" + DeviceId + "\", Version=\"10.11.2\", Token=\"" + Token + "\"";
    private const string TwoCrashes = """
        {
            "crashes": [
                { "probe": "native-audio", "steps": ["check mp4a.40.2", "decode aac"] },
                { "probe": "hevc-main10", "steps": [] }
            ]
        }
        """;

    private const string EveryFallbackKind = """
        {
            "fallbacks": [
                { "kind": "presentation", "reason": "adapter-unavailable", "detail": "requestAdapter: null" },
                { "kind": "device-lost", "reason": "unknown", "detail": "" },
                { "kind": "custom-playback-fallback", "reason": "decode-failed", "detail": "same-session-native" },
                { "kind": "custom-playback-declined", "reason": "codec-unsupported", "detail": "html-backend" }
            ]
        }
        """;

    private static readonly string ControllerCategory = typeof(DiagnosticsController).FullName!;

    public static TheoryData<string> InvalidReports => new TheoryData<string>
    {
        "not json",
        """[]""",
        """{}""",
        """{ "crashes": null }""",
        """{ "crashes": {} }""",
        """{ "crashes": [] }""",
        Report(Enumerable.Range(0, ProbeCrashFunctions.MaximumCrashCount + 1).Select(index => Crash("probe" + index, [])).ToArray()),
        """{ "crashes": [ { "probe": "native-audio", "steps": [], } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": [] } ], "crashes": [ { "probe": "native-audio", "steps": [] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": [] } ], "user": "admin" }""",
        """{ "crashes": [ "native-audio" ] }""",
        """{ "crashes": [ null ] }""",
        """{ "crashes": [ { "steps": [] } ] }""",
        """{ "crashes": [ { "probe": "native-audio" } ] }""",
        """{ "crashes": [ { "probe": null, "steps": [] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": null } ] }""",
        """{ "crashes": [ { "probe": 1, "steps": [] } ] }""",
        """{ "crashes": [ { "probe": "", "steps": [] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": "decode aac" } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": [null] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": [1] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": [""] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": [["decode aac"]] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": [], "token": "x" } ] }""",
        Report(Crash(new string('p', ProbeCrashFunctions.MaximumProbeLength + 1), [])),
        Report(Crash("native-audio", [new string('s', ProbeCrashFunctions.MaximumStepLength + 1)])),
        Report(Crash("native-audio", Enumerable.Range(0, ProbeCrashFunctions.MaximumStepCount + 1).Select(index => "step " + index).ToArray())),
        """{ "crashes": [ { "probe": "native\u0001audio", "steps": [] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": ["decode aac\n"] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": ["decode aac\u007f"] } ] }""",
        """{ "crashes": [ { "probe": "native-\u00e9audio", "steps": [] } ] }""",
        """{ "crashes": [ { "probe": "native-audio", "steps": ["decode \ud800"] } ] }"""
    };

    public static TheoryData<string> InvalidPlaybackFallbackReports => new TheoryData<string>
    {
        "not json",
        """[]""",
        """{}""",
        """{ "fallbacks": null }""",
        """{ "fallbacks": {} }""",
        """{ "fallbacks": [] }""",
        FallbackReport(Enumerable.Range(0, PlaybackFallbackFunctions.MaximumFallbackCount + 1).Select(index => Fallback("presentation", "reason-" + index, string.Empty)).ToArray()),
        """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-unavailable", "detail": "" } ], "user": "admin" }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-unavailable", "detail": "", "token": "x" } ] }""",
        """{ "fallbacks": [ null ] }""",
        """{ "fallbacks": [ { "reason": "adapter-unavailable", "detail": "" } ] }""",
        """{ "fallbacks": [ { "kind": "crash", "reason": "adapter-unavailable", "detail": "" } ] }""",
        """{ "fallbacks": [ { "kind": "Presentation", "reason": "adapter-unavailable", "detail": "" } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "detail": "" } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": "", "detail": "" } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": 1, "detail": "" } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-unavailable" } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-unavailable", "detail": null } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-unavailable", "detail": ["requestAdapter: null"] } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-unavailable", "detail": "requestAdapter: null\n[ERR] forged" } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-\u00e9", "detail": "" } ] }""",
        """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-unavailable", "detail": "\ud800" } ] }""",
        FallbackReport(Fallback("presentation", new string('r', PlaybackFallbackFunctions.MaximumReasonLength + 1), string.Empty)),
        FallbackReport(Fallback("presentation", "adapter-unavailable", new string('d', PlaybackFallbackFunctions.MaximumDetailLength + 1)))
    };

    [Fact]
    public async Task ReportProbeCrashes_Anonymous_IsUnauthorizedAndLogsNothing()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.PostAsync(new Uri(ProbeCrashesPath, UriKind.Relative), CreateBody(TwoCrashes), cancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(ReadWarnings(logs));
    }

    [Fact]
    public async Task ReportProbeCrashes_SignedInUser_LogsAWarningPerCrashWithTheClientButNoSecret()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage response = await PostAsync(client, ProbeCrashesPath, TwoCrashes, ClientAuthorization, null, cancellationToken);
        IReadOnlyList<RecordingLoggerProvider.Entry> warnings = ReadWarnings(logs);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(cancellationToken));
        Assert.Equal(2, warnings.Count);
        Assert.Equal(
            "WebGPU Player: the capability probe native-audio stopped a page during check mp4a.40.2, decode aac on Jellyfin Web 10.11.2 (Safari, " + SafariUserAgent + ")",
            warnings[0].Message);
        Assert.Equal("native-audio", warnings[0].Properties["Probe"]);
        Assert.Equal("check mp4a.40.2, decode aac", warnings[0].Properties["Steps"]);
        Assert.Equal("Jellyfin Web", warnings[0].Properties["Client"]);
        Assert.Equal("10.11.2", warnings[0].Properties["ClientVersion"]);
        Assert.Equal("Safari", warnings[0].Properties["Device"]);
        Assert.Equal(SafariUserAgent, warnings[0].Properties["UserAgent"]);
        Assert.Equal("hevc-main10", warnings[1].Properties["Probe"]);
        Assert.Equal(ProbeCrashFunctions.NoSteps, warnings[1].Properties["Steps"]);
        foreach (RecordingLoggerProvider.Entry entry in logs.Entries)
        {
            string logged = entry.Message + string.Join(" ", entry.Properties.Values);
            Assert.DoesNotContain(Token, logged, StringComparison.Ordinal);
            Assert.DoesNotContain(DeviceId, logged, StringComparison.Ordinal);
            Assert.DoesNotContain("MediaBrowser", logged, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task ReportProbeCrashes_ClientInEmbyAuthorization_LogsThatClient()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        // The add-on's own requests carry only the token in Authorization
        using HttpResponseMessage response = await PostAsync(client, ProbeCrashesPath, TwoCrashes, "MediaBrowser Token=\"" + Token + "\"", ClientAuthorization, cancellationToken);
        IReadOnlyList<RecordingLoggerProvider.Entry> warnings = ReadWarnings(logs);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(2, warnings.Count);
        Assert.Equal("Jellyfin Web", warnings[0].Properties["Client"]);
        Assert.Equal("10.11.2", warnings[0].Properties["ClientVersion"]);
        Assert.Equal("Safari", warnings[0].Properties["Device"]);
        Assert.DoesNotContain(logs.Entries, entry => entry.Message.Contains(Token, StringComparison.Ordinal));
    }

    [Fact]
    public async Task ReportProbeCrashes_NoClientHeaders_LogsAnUnknownClient()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage response = await client.PostAsync(new Uri(ProbeCrashesPath, UriKind.Relative), CreateBody(Report(Crash("native-audio", ["decode aac"]))), cancellationToken);
        RecordingLoggerProvider.Entry warning = Assert.Single(ReadWarnings(logs));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(ReportFunctions.Unknown, warning.Properties["Client"]);
        Assert.Equal(ReportFunctions.Unknown, warning.Properties["ClientVersion"]);
        Assert.Equal(ReportFunctions.Unknown, warning.Properties["Device"]);
        Assert.Equal(ReportFunctions.Unknown, warning.Properties["UserAgent"]);
    }

    [Fact]
    public async Task ReportProbeCrashes_LargestValidReport_LogsEveryCrash()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);
        // Strings of quotes and backslashes only, which JSON.stringify escapes, at every limit still fit the body limit
        string step = string.Concat(Enumerable.Repeat("\\\"", ProbeCrashFunctions.MaximumStepLength));
        string[] steps = Enumerable.Repeat(step, ProbeCrashFunctions.MaximumStepCount).ToArray();
        string report = Report(Enumerable.Range(0, ProbeCrashFunctions.MaximumCrashCount)
            .Select(index => Crash(index.ToString("D2", CultureInfo.InvariantCulture) + string.Concat(Enumerable.Repeat("\\\\", ProbeCrashFunctions.MaximumProbeLength - 2)), steps))
            .ToArray());

        using HttpResponseMessage response = await client.PostAsync(new Uri(ProbeCrashesPath, UriKind.Relative), CreateBody(report), cancellationToken);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(ProbeCrashFunctions.MaximumCrashCount, ReadWarnings(logs).Count);
    }

    [Theory]
    [MemberData(nameof(InvalidReports))]
    public async Task ReportProbeCrashes_InvalidReport_IsRefusedAndLogsNothing(string report)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage response = await client.PostAsync(new Uri(ProbeCrashesPath, UriKind.Relative), CreateBody(report), cancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(ProbeCrashFunctions.InvalidCode, await ReadCodeAsync(response, cancellationToken));
        Assert.Empty(ReadWarnings(logs));
    }

    [Fact]
    public async Task ReportProbeCrashes_OversizeBody_IsRefusedAndLogsNothing()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);
        string report = """{ "crashes": [ { "probe": "native-audio", "steps": [] } ], "padding": " """ + new string('a', ProbeCrashFunctions.MaximumByteLength) + "\" }";

        using HttpResponseMessage response = await client.PostAsync(new Uri(ProbeCrashesPath, UriKind.Relative), CreateBody(report), cancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(ProbeCrashFunctions.SizeCode, await ReadCodeAsync(response, cancellationToken));
        Assert.Empty(ReadWarnings(logs));
    }

    [Fact]
    public async Task ReportPlaybackFallbacks_Anonymous_IsUnauthorizedAndLogsNothing()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.PostAsync(new Uri(PlaybackFallbacksPath, UriKind.Relative), CreateBody(EveryFallbackKind), cancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(ReadControllerEntries(logs));
    }

    [Fact]
    public async Task ReportPlaybackFallbacks_SignedInUser_LogsEachFallbackAtItsKindsLevelWithTheClientButNoSecret()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage response = await PostAsync(client, PlaybackFallbacksPath, EveryFallbackKind, ClientAuthorization, null, cancellationToken);
        IReadOnlyList<RecordingLoggerProvider.Entry> entries = ReadControllerEntries(logs);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(cancellationToken));
        Assert.Equal(
            "WebGPU Player: WebGPU presentation fell back to the browser's video (adapter-unavailable: requestAdapter: null) on Jellyfin Web 10.11.2 (Safari, " + SafariUserAgent + ")",
            entries[0].Message);
        // A declined source is the route working as designed, so it is information, not a warning
        Assert.Equal(new[] { LogLevel.Warning, LogLevel.Warning, LogLevel.Warning, LogLevel.Information }, entries.Select(entry => entry.Level).ToArray());
        Assert.Equal(
            new[] { "adapter-unavailable", "unknown", "decode-failed", "codec-unsupported" },
            entries.Select(entry => (string?)entry.Properties["Reason"]).ToArray());
        Assert.Equal(
            new[] { "requestAdapter: null", PlaybackFallbackFunctions.NoDetail, "same-session-native", "html-backend" },
            entries.Select(entry => (string?)entry.Properties["Detail"]).ToArray());
        foreach (RecordingLoggerProvider.Entry entry in entries)
        {
            Assert.Equal("Jellyfin Web", entry.Properties["Client"]);
            Assert.Equal("10.11.2", entry.Properties["ClientVersion"]);
            Assert.Equal("Safari", entry.Properties["Device"]);
            Assert.Equal(SafariUserAgent, entry.Properties["UserAgent"]);
            string logged = entry.Message + string.Join(" ", entry.Properties.Values);
            Assert.DoesNotContain(Token, logged, StringComparison.Ordinal);
            Assert.DoesNotContain(DeviceId, logged, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task ReportPlaybackFallbacks_LargestValidReport_LogsEveryFallback()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);
        // Strings of quotes and backslashes only, which JSON.stringify escapes, at every limit still fit the body limit
        string reason = string.Concat(Enumerable.Repeat("\\\"", PlaybackFallbackFunctions.MaximumReasonLength));
        string detail = string.Concat(Enumerable.Repeat("\\\\", PlaybackFallbackFunctions.MaximumDetailLength));
        string report = FallbackReport(Enumerable.Repeat(Fallback(PlaybackFallbackFunctions.CustomPlaybackDeclinedKind, reason, detail), PlaybackFallbackFunctions.MaximumFallbackCount).ToArray());

        using HttpResponseMessage response = await client.PostAsync(new Uri(PlaybackFallbacksPath, UriKind.Relative), CreateBody(report), cancellationToken);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(PlaybackFallbackFunctions.MaximumFallbackCount, ReadControllerEntries(logs).Count);
    }

    [Theory]
    [MemberData(nameof(InvalidPlaybackFallbackReports))]
    public async Task ReportPlaybackFallbacks_InvalidReport_IsRefusedAndLogsNothing(string report)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage response = await client.PostAsync(new Uri(PlaybackFallbacksPath, UriKind.Relative), CreateBody(report), cancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(PlaybackFallbackFunctions.InvalidCode, await ReadCodeAsync(response, cancellationToken));
        Assert.Empty(ReadControllerEntries(logs));
    }

    [Fact]
    public async Task ReportPlaybackFallbacks_OversizeBody_IsRefusedAndLogsNothing()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        RecordingLoggerProvider logs = new RecordingLoggerProvider();
        await using WebApplication application = await StartServerAsync(logs, cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);
        string report = """{ "fallbacks": [ { "kind": "presentation", "reason": "adapter-unavailable", "detail": "" } ], "padding": " """ + new string('a', PlaybackFallbackFunctions.MaximumByteLength) + "\" }";

        using HttpResponseMessage response = await client.PostAsync(new Uri(PlaybackFallbacksPath, UriKind.Relative), CreateBody(report), cancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(PlaybackFallbackFunctions.SizeCode, await ReadCodeAsync(response, cancellationToken));
        Assert.Empty(ReadControllerEntries(logs));
    }

    private static string Crash(string probe, string[] steps)
    {
        return "{ \"probe\": \"" + probe + "\", \"steps\": [" + string.Join(", ", steps.Select(step => "\"" + step + "\"")) + "] }";
    }

    private static string Report(params string[] crashes)
    {
        return "{ \"crashes\": [" + string.Join(", ", crashes) + "] }";
    }

    private static string Fallback(string kind, string reason, string detail)
    {
        return "{ \"kind\": \"" + kind + "\", \"reason\": \"" + reason + "\", \"detail\": \"" + detail + "\" }";
    }

    private static string FallbackReport(params string[] fallbacks)
    {
        return "{ \"fallbacks\": [" + string.Join(", ", fallbacks) + "] }";
    }

    private static StringContent CreateBody(string report)
    {
        return new StringContent(report, Encoding.UTF8, JsonContentType);
    }

    private static async Task<HttpResponseMessage> PostAsync(HttpClient client, string path, string report, string? authorization, string? embyAuthorization, CancellationToken cancellationToken)
    {
        using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, new Uri(path, UriKind.Relative));
        request.Content = CreateBody(report);
        request.Headers.TryAddWithoutValidation("User-Agent", SafariUserAgent);
        if (authorization is not null)
        {
            request.Headers.TryAddWithoutValidation("Authorization", authorization);
        }

        if (embyAuthorization is not null)
        {
            request.Headers.TryAddWithoutValidation("X-Emby-Authorization", embyAuthorization);
        }

        return await client.SendAsync(request, cancellationToken);
    }

    private static async Task<string?> ReadCodeAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        using JsonDocument problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        return problem.RootElement.GetProperty("code").GetString();
    }

    private static List<RecordingLoggerProvider.Entry> ReadWarnings(RecordingLoggerProvider logs)
    {
        return logs.Entries.Where(entry => entry.Category == ControllerCategory && entry.Level == LogLevel.Warning).ToList();
    }

    // The playback fallback route logs warnings and information
    private static List<RecordingLoggerProvider.Entry> ReadControllerEntries(RecordingLoggerProvider logs)
    {
        return logs.Entries.Where(entry => entry.Category == ControllerCategory).ToList();
    }

    private static Task<WebApplication> StartServerAsync(RecordingLoggerProvider logs, CancellationToken cancellationToken)
    {
        return RoleHeaderTestServer.StartAsync(services => services.AddSingleton<ILoggerProvider>(logs), cancellationToken);
    }
}
