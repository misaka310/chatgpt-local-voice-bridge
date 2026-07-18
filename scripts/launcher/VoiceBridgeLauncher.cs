using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("ChatGPT Local Voice Bridge Launcher")]
[assembly: System.Reflection.AssemblyProduct("ChatGPT Local Voice Bridge")]
[assembly: System.Reflection.AssemblyDescription("Small Windows launcher for the local tray application")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace ChatGPTLocalVoiceBridgeLauncher
{
    internal static class Program
    {
        private const string AppTitle = "ChatGPT Local Voice Bridge";

        [STAThread]
        private static int Main(string[] args)
        {
            bool selfTest = HasArgument(args, "--self-test");
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string localApi = Path.Combine(root, "local-api");
            string python = Path.Combine(localApi, ".venv", "Scripts", "python.exe");
            string pythonw = Path.Combine(localApi, ".venv", "Scripts", "pythonw.exe");
            string controller = Path.Combine(localApi, "tray_controller.py");

            string validationError = ValidateEnvironment(python, pythonw, controller, localApi);
            if (!String.IsNullOrEmpty(validationError))
            {
                if (!selfTest)
                {
                    ShowError(validationError);
                }
                return 2;
            }

            if (selfTest)
            {
                return 0;
            }

            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = pythonw;
                startInfo.Arguments = Quote(controller);
                startInfo.WorkingDirectory = localApi;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(startInfo);
                return 0;
            }
            catch (Exception ex)
            {
                ShowError("起動に失敗しました。\n\n" + ex.Message);
                return 3;
            }
        }

        private static string ValidateEnvironment(string python, string pythonw, string controller, string workingDirectory)
        {
            if (!File.Exists(python) || !File.Exists(pythonw))
            {
                return "音声環境がありません。setup-voice-env.cmd を実行してください。";
            }

            if (!File.Exists(controller))
            {
                return "local-api\\tray_controller.py が見つかりません。";
            }

            try
            {
                ProcessStartInfo checkInfo = new ProcessStartInfo();
                checkInfo.FileName = python;
                checkInfo.Arguments = "-c \"from PySide6 import QtWidgets, QtSvg\"";
                checkInfo.WorkingDirectory = workingDirectory;
                checkInfo.UseShellExecute = false;
                checkInfo.CreateNoWindow = true;
                checkInfo.WindowStyle = ProcessWindowStyle.Hidden;

                using (Process check = Process.Start(checkInfo))
                {
                    if (check == null)
                    {
                        return "Python環境を確認できませんでした。setup-voice-env.cmd を再実行してください。";
                    }
                    check.WaitForExit();
                    if (check.ExitCode != 0)
                    {
                        return "PySide6 が見つかりません。setup-voice-env.cmd を再実行してください。";
                    }
                }
            }
            catch (Exception ex)
            {
                return "Python環境を確認できませんでした。\n\n" + ex.Message;
            }

            return null;
        }

        private static bool HasArgument(string[] args, string expected)
        {
            if (args == null)
            {
                return false;
            }

            foreach (string arg in args)
            {
                if (String.Equals(arg, expected, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void ShowError(string message)
        {
            Application.EnableVisualStyles();
            MessageBox.Show(message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
