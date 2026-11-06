using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

// Keeps every log entry of a test server, with its rendered message and its structured properties
internal sealed class RecordingLoggerProvider : ILoggerProvider
{
    private readonly ConcurrentQueue<Entry> entries = new ConcurrentQueue<Entry>();

    public IReadOnlyList<Entry> Entries => entries.ToArray();

    public ILogger CreateLogger(string categoryName)
    {
        return new RecordingLogger(categoryName, entries);
    }

    public void Dispose()
    {
    }

    public sealed record Entry(string Category, LogLevel Level, string Message, IReadOnlyDictionary<string, object?> Properties);

    private sealed class RecordingLogger(string category, ConcurrentQueue<Entry> entries) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
        {
            return null;
        }

        public bool IsEnabled(LogLevel logLevel)
        {
            return true;
        }

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            IEnumerable<KeyValuePair<string, object?>> properties = state as IEnumerable<KeyValuePair<string, object?>> ?? [];
            entries.Enqueue(new Entry(
                category,
                logLevel,
                formatter(state, exception),
                properties.ToDictionary(property => property.Key, property => property.Value, StringComparer.Ordinal)));
        }
    }
}
