using System;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer;
using Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;
using Jellyfin.Plugin.WebGPUPlayer.DevHost;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// Serves the plugin's routes on a loopback port of its own, as a server with the plugin installed serves them, with the plugin's data folder in --data-folder.
// A request signs in as the user of the Jellyfin server at --server whose credentials it carries.
// Once it listens, it writes ReadyPrefix and its address on a line of its own, which serve-jellyfin-web-client.js waits for.
// It stops once its standard input closes, as it does when that script exits, however the script exits
const string ReadyPrefix = "WebGPU Player plugin host listening on ";

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);
Uri server = ServerUserAuthenticationHandler.GetBaseAddress(builder.Configuration["server"] ?? throw new InvalidOperationException("--server is required"));
string dataFolderPath = builder.Configuration["data-folder"] ?? throw new InvalidOperationException("--data-folder is required");
builder.WebHost.UseUrls("http://127.0.0.1:0");
// The plugin's own logs stay; the host's requests, and its sign-in of each, log only their problems
builder.Logging.AddFilter("Microsoft", LogLevel.Warning);
builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
builder.Logging.AddFilter(typeof(ServerUserAuthenticationHandler).FullName, LogLevel.Warning);

// The plugin's services, as PluginServiceRegistrator registers them, with the data folder given here
builder.Services.AddSingleton(provider => ModuleStore.OpenBundled(dataFolderPath, provider.GetRequiredService<ILogger<ModuleStore>>()));
builder.Services.AddSingleton(provider => new ClientDefaultsStore(dataFolderPath, provider.GetRequiredService<ILogger<ClientDefaultsStore>>()));

builder.Services.AddMemoryCache();
builder.Services.AddHttpClient(ServerUserAuthenticationHandler.HttpClientName, client => client.BaseAddress = server);
builder.Services.AddAuthentication(ServerUserAuthenticationHandler.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, ServerUserAuthenticationHandler>(ServerUserAuthenticationHandler.SchemeName, null);
// The server's own policy elevates administrators
builder.Services.AddAuthorization(options => options.AddPolicy(
    Policies.RequiresElevation,
    policy => policy.RequireRole(ServerUserAuthenticationHandler.AdministratorRole)));
builder.Services.AddControllers().AddApplicationPart(typeof(Plugin).Assembly);

WebApplication application = builder.Build();
application.UseAuthentication();
application.UseAuthorization();
application.MapControllers();
await application.StartAsync().ConfigureAwait(false);
Console.WriteLine(ReadyPrefix + application.Urls.First());
IHostApplicationLifetime lifetime = application.Lifetime;
_ = Task.Run(async () =>
{
    await Console.In.ReadToEndAsync().ConfigureAwait(false);
    lifetime.StopApplication();
});
await application.WaitForShutdownAsync().ConfigureAwait(false);
