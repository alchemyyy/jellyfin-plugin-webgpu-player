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

        using HttpResponseMessage response = await PostAsync(client, TwoCrashes, ClientAuthorization, null, cancellationToken);
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
        using HttpResponseMessage response = await PostAsync(client, TwoCrashes, "MediaBrowser Token=\"" + Token + "\"", ClientAuthorization, cancellationToken);
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
        Assert.Equal(ProbeCrashFunctions.Unknown, warning.Properties["Client"]);
        Assert.Equal(ProbeCrashFunctions.Unknown, warning.Properties["ClientVersion"]);
        Assert.Equal(ProbeCrashFunctions.Unknown, warning.Properties["Device"]);
        Assert.Equal(ProbeCrashFunctions.Unknown, warning.Properties["UserAgent"]);
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
        Assert.Equal(ProbeCrashProblem.InvalidCode, await ReadCodeAsync(response, cancellationToken));
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
        Assert.Equal(ProbeCrashProblem.SizeCode, await ReadCodeAsync(response, cancellationToken));
        Assert.Empty(ReadWarnings(logs));
    }

    private static string Crash(string probe, string[] steps)
    {
        return "{ \"probe\": \"" + probe + "\", \"steps\": [" + string.Join(", ", steps.Select(step => "\"" + step + "\"")) + "] }";
    }

    private static string Report(params string[] crashes)
    {
        return "{ \"crashes\": [" + string.Join(", ", crashes) + "] }";
    }

    private static StringContent CreateBody(string report)
    {
        return new StringContent(report, Encoding.UTF8, JsonContentType);
    }

    private static async Task<HttpResponseMessage> PostAsync(HttpClient client, string report, string? authorization, string? embyAuthorization, CancellationToken cancellationToken)
    {
        using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, new Uri(ProbeCrashesPath, UriKind.Relative));
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

    private static Task<WebApplication> StartServerAsync(RecordingLoggerProvider logs, CancellationToken cancellationToken)
    {
        return RoleHeaderTestServer.StartAsync(services => services.AddSingleton<ILoggerProvider>(logs), cancellationToken);
    }
}
