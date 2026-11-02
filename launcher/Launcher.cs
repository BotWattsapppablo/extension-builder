using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

// Extension Builder.exe — the double-click entry point.
//
// It is only a launcher: it finds the "extension builder" project folder, finds
// node.exe, and runs start-app.mjs, which opens the real window. Nothing is
// packaged, so the exe always runs whatever the project contains today.
static class Launcher
{
    [STAThread]
    static void Main()
    {
        // A winexe has no console, so an escaping exception would vanish silently.
        try { Start(); }
        catch (Exception ex) { Fail("Extension Builder could not start.\n\n" + ex.Message); }
    }

    static void Start()
    {
        string project;
        try { project = Environment.GetEnvironmentVariable("BUILDER_PROJECT"); } catch { project = null; }
        if (string.IsNullOrEmpty(project) || !LooksLikeProject(project))
        {
            project = FindProject();
            if (project == null && !AskForProject(out project)) return; // user gave up
        }

        string node = FindNode();
        if (node == null)
        {
            Fail("Node.js was not found on this computer.\n\n" +
                 "Install it from https://nodejs.org (the LTS installer), then try again.");
            return;
        }

        Run(node, project);
    }

    // ── launching ────────────────────────────────────────────────────────────

    static void Run(string node, string project)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = "\"" + Path.Combine(project, "start-app.mjs") + "\"";
        psi.WorkingDirectory = project;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;

        StringBuilder output = new StringBuilder();
        try
        {
            using (Process p = new Process())
            {
                p.StartInfo = psi;
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) output.AppendLine(e.Data); };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) output.AppendLine(e.Data); };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                // The window appears within a couple of seconds. If the process is
                // still alive after that, the app is up and this launcher is done.
                if (p.WaitForExit(8000))
                {
                    if (p.ExitCode == 0) return;
                    Fail("The builder could not start.\n\n" + Trim(output.ToString()));
                }
            }
        }
        catch (Exception ex)
        {
            Fail("The builder could not start.\n\n" + ex.Message);
        }
    }

    // ── finding the project ──────────────────────────────────────────────────

    static string ExeDir()
    {
        try { return Path.GetDirectoryName(Application.ExecutablePath); }
        catch { return Directory.GetCurrentDirectory(); }
    }

    static bool LooksLikeProject(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return false;
        try
        {
            return File.Exists(Path.Combine(dir, "start-app.mjs")) &&
                   File.Exists(Path.Combine(dir, "app", "main.mjs"));
        }
        catch { return false; }
    }

    static string FindProject()
    {
        string exe = ExeDir();
        string pointer = ReadPointer(Path.Combine(exe, "builder.path"));
        string saved = ReadPointer(SettingsFile());

        List<string> tries = new List<string>();
        Add(tries, pointer);
        Add(tries, saved);
        Add(tries, exe);
        Add(tries, Path.Combine(exe, "extension builder"));
        Add(tries, Path.Combine(Home(), @"OneDrive\Desktop\manga reader\extension builder"));
        Add(tries, Path.Combine(Home(), @"Desktop\manga reader\extension builder"));
        Add(tries, Path.Combine(Home(), @"OneDrive\Desktop\extension builder"));
        Add(tries, Path.Combine(Home(), @"Desktop\extension builder"));

        foreach (string t in tries)
        {
            string dir = Clean(t);
            if (LooksLikeProject(dir)) return dir;
        }
        return null;
    }

    static void Add(List<string> list, string value)
    {
        if (!string.IsNullOrWhiteSpace(value)) list.Add(value);
    }

    static bool AskForProject(out string project)
    {
        project = null;
        FolderBrowserDialog dlg = new FolderBrowserDialog();
        dlg.Description = "Pick the \"extension builder\" folder (the one that contains start-app.mjs).";
        dlg.ShowNewFolderButton = false;
        while (true)
        {
            if (dlg.ShowDialog() != DialogResult.OK) return false;
            if (LooksLikeProject(dlg.SelectedPath))
            {
                project = dlg.SelectedPath;
                WritePointer(SettingsFile(), project);
                return true;
            }
            if (MessageBox.Show("That folder is not the extension builder.\n\nTry another one?",
                    "Extension Builder", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                return false;
        }
    }

    static string SettingsFile()
    {
        string appData = Environment.GetEnvironmentVariable("APPDATA");
        if (string.IsNullOrEmpty(appData)) appData = Path.GetTempPath();
        return Path.Combine(appData, "MihonPC Extension Builder", "project.txt");
    }

    // ── finding node ─────────────────────────────────────────────────────────

    static string FindNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH");
        if (path != null)
        {
            foreach (string dir in path.Split(';'))
            {
                if (string.IsNullOrEmpty(dir)) continue;
                string candidate = Clean(Path.Combine(dir.Trim(), "node.exe"));
                if (File.Exists(candidate)) return candidate;
            }
        }
        foreach (string root in new string[] {
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
        {
            if (string.IsNullOrEmpty(root)) continue;
            string candidate = Clean(Path.Combine(root, @"nodejs\node.exe"));
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    // ── small helpers ────────────────────────────────────────────────────────

    static string Home() { return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); }

    static string Clean(string p)
    {
        try { return Path.GetFullPath(p); } catch { return p; }
    }

    static string Trim(string s)
    {
        s = s == null ? "" : s.Trim();
        return s.Length > 900 ? s.Substring(0, 900) + "\n…" : s;
    }

    static string ReadPointer(string file)
    {
        try { return File.Exists(file) ? File.ReadAllText(file).Trim() : null; }
        catch { return null; }
    }

    static void WritePointer(string file, string value)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            File.WriteAllText(file, value);
        }
        catch { /* the choice just won't be remembered */ }
    }

    static void Fail(string message)
    {
        MessageBox.Show(message, "Extension Builder", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
