#if UNITY_EDITOR
using System;
using System.Diagnostics;
using System.IO;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace TikTokLiveGame.EditorTools
{
    /// <summary>
    /// Isolated comparison probe. This does not touch the production Kokoro
    /// pipeline and is not required at runtime.
    /// </summary>
    public static class WindowsSapiTtsProbe
    {
        private const string MenuRoot = "Tools/Cloud Disco/Experimental/";

        [MenuItem(MenuRoot + "List Windows SAPI Voices")]
        public static void ListVoices()
        {
            if (!IsWindowsEditor()) return;
            string script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; " +
                            "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
                            "ForEach-Object { $_.VoiceInfo.Name + ' | ' + $_.VoiceInfo.Culture.Name + ' | ' + $_.VoiceInfo.Gender }";
            RunPowerShell(script, out string stdout, out string stderr);
            if (!string.IsNullOrWhiteSpace(stderr))
                Debug.LogWarning($"[SAPI probe] {stderr.Trim()}");
            Debug.Log("[SAPI probe] Installed voices:\n" + stdout.Trim());
        }

        [MenuItem(MenuRoot + "Generate Windows SAPI WAV")]
        public static void GenerateWave()
        {
            if (!IsWindowsEditor()) return;
            string output = Path.Combine(
                Path.GetTempPath(),
                $"cloud-disco-unity-sapi-{DateTime.Now:yyyyMMdd-HHmmss}.wav");
            const string text = "Cloud Disco native Windows SAPI probe. This is American English.";
            string safeOutput = output.Replace("'", "''");
            string safeText = text.Replace("'", "''");
            string script =
                "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; " +
                "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
                "$s.SelectVoice('Microsoft David Desktop'); " +
                "$s.Volume=100; $s.Rate=0; " +
                $"$s.SetOutputToWaveFile('{safeOutput}'); $s.Speak('{safeText}'); $s.Dispose()";
            RunPowerShell(script, out string stdout, out string stderr);
            if (!string.IsNullOrWhiteSpace(stdout)) Debug.Log($"[SAPI probe] {stdout.Trim()}");
            if (!string.IsNullOrWhiteSpace(stderr)) Debug.LogWarning($"[SAPI probe] {stderr.Trim()}");
            if (!File.Exists(output))
            {
                Debug.LogError("[SAPI probe] Windows SAPI did not produce a WAV file.");
                return;
            }
            var info = new FileInfo(output);
            Debug.Log($"[SAPI probe] Generated '{output}' ({info.Length} bytes). " +
                      "This is a native SAPI WAV probe; production playback remains Kokoro -> bridge -> Unity.");
            EditorUtility.RevealInFinder(output);
        }

        private static bool IsWindowsEditor()
        {
            if (Application.platform == RuntimePlatform.WindowsEditor) return true;
            Debug.LogWarning("[SAPI probe] Windows SAPI is only available in the Windows Editor.");
            return false;
        }

        private static void RunPowerShell(string script, out string stdout, out string stderr)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" +
                            script.Replace("\"", "\\\"") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            try
            {
                using (Process process = Process.Start(startInfo))
                {
                    if (process == null)
                    {
                        stdout = string.Empty;
                        stderr = "Could not start powershell.exe.";
                        return;
                    }
                    stdout = process.StandardOutput.ReadToEnd();
                    stderr = process.StandardError.ReadToEnd();
                    process.WaitForExit(30000);
                    if (process.ExitCode != 0 && string.IsNullOrWhiteSpace(stderr))
                        stderr = $"powershell.exe exited with code {process.ExitCode}.";
                }
            }
            catch (Exception error)
            {
                stdout = string.Empty;
                stderr = error.Message;
            }
        }
    }
}
#endif
