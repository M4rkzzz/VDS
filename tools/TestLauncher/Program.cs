using System.Diagnostics;

namespace Vds.TestLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new LauncherForm());
    }
}

internal sealed class LauncherForm : Form
{
    private readonly string repoRoot;
    private readonly Label statusLabel = new();
    private readonly TextBox commandPreview = new();

    private readonly LauncherCommand[] commands =
    [
        new("双端 Native Peer", "npm run dev:dual:native", "启动本地 server + 两个 Electron 客户端，并启用 native peer transport/media-agent 链路。"),
        new("双端默认 Peer", "npm run dev:dual", "启动本地 server + 两个 Electron 客户端，使用默认 peer transport；不是 Web viewer。"),
        new("双端 Web", "npm run dev:dual:web", "启动 Electron host，并打开浏览器 Web viewer。"),
        new("三端 Native", "npm run dev:triple:native", "启动三个 Electron 客户端，启用 native peer transport。"),
        new("三端 NWN", "npm run triple:nwn", "启动 native host + Web viewer + native viewer 组合。"),
        new("媒体验证", "npm run verify:media-agent", "构建 media-agent、运行 CTest 和 smoke 测试。"),
        new("E2E 清单", "npm run e2e:media-agent", "输出人工端到端验收清单。"),
        new("服务端测试", "npm run test:server", "运行 server-core 自动化测试。"),
        new("Web 协议测试", "npm run test:vds-web", "运行 VDS Web datachannel/WebCodecs 协议测试。"),
        new("日志门禁", "npm run check:logging", "检查裸日志输出是否符合策略。"),
        new("Docker Context", "npm run check:server-docker", "检查 server Docker context 必要产物。"),
        new("完整快速验证", "npm run test:server; npm run test:vds-web; npm run check:server-docker; npm run check:logging", "运行服务端、Web 协议、Docker context 和日志门禁。")
    ];

    public LauncherForm()
    {
        repoRoot = LocateRepoRoot();
        Text = "VDS 测试启动器";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(620, 520);
        Size = new Size(720, 620);
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

        var rootLabel = new Label
        {
            Text = $"项目目录：{repoRoot}",
            AutoEllipsis = true,
            Dock = DockStyle.Top,
            Height = 28,
            TextAlign = ContentAlignment.MiddleLeft
        };

        var grid = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 0,
            Padding = new Padding(12),
            AutoScroll = true
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));

        foreach (var command in commands)
        {
            var button = new Button
            {
                Text = command.Label,
                Dock = DockStyle.Fill,
                Height = 48,
                Margin = new Padding(6),
                Tag = command
            };
            button.Click += (_, _) => RunCommand(command);
            button.MouseEnter += (_, _) => ShowCommand(command);
            grid.Controls.Add(button);
        }

        commandPreview.Dock = DockStyle.Bottom;
        commandPreview.Height = 76;
        commandPreview.Multiline = true;
        commandPreview.ReadOnly = true;
        commandPreview.ScrollBars = ScrollBars.Vertical;
        commandPreview.Text = "悬停按钮查看命令；点击后会打开新的 PowerShell 窗口执行。";

        statusLabel.Dock = DockStyle.Bottom;
        statusLabel.Height = 32;
        statusLabel.TextAlign = ContentAlignment.MiddleLeft;
        statusLabel.Text = "就绪";

        var openRepoButton = new Button
        {
            Text = "打开项目目录",
            Dock = DockStyle.Bottom,
            Height = 36
        };
        openRepoButton.Click += (_, _) => Process.Start(new ProcessStartInfo
        {
            FileName = repoRoot,
            UseShellExecute = true
        });

        Controls.Add(grid);
        Controls.Add(commandPreview);
        Controls.Add(openRepoButton);
        Controls.Add(statusLabel);
        Controls.Add(rootLabel);
    }

    private void ShowCommand(LauncherCommand command)
    {
        commandPreview.Text = $"{command.Description}{Environment.NewLine}{Environment.NewLine}{command.Command}";
    }

    private void RunCommand(LauncherCommand command)
    {
        try
        {
            var escapedRoot = EscapePowerShellSingleQuoted(repoRoot);
            var escapedCommand = EscapePowerShellSingleQuoted(command.Command);
            var title = EscapePowerShellSingleQuoted($"VDS - {command.Label}");
            var script = "$Host.UI.RawUI.WindowTitle = '" + title + "'; " +
                         "Set-Location -LiteralPath '" + escapedRoot + "'; " +
                         "Write-Host '" + escapedCommand + "'; " +
                         command.Command;

            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoExit -ExecutionPolicy Bypass -Command \"" + script.Replace("\"", "`\"") + "\"",
                WorkingDirectory = repoRoot,
                UseShellExecute = true
            });
            statusLabel.Text = $"已启动：{command.Label}";
            ShowCommand(command);
        }
        catch (Exception ex)
        {
            statusLabel.Text = "启动失败";
            MessageBox.Show(this, ex.Message, "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string LocateRepoRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null)
        {
            var packageJson = Path.Combine(current.FullName, "package.json");
            var scriptsDir = Path.Combine(current.FullName, "scripts");
            if (File.Exists(packageJson) && Directory.Exists(scriptsDir))
            {
                return current.FullName;
            }
            current = current.Parent;
        }

        var workingDirectory = new DirectoryInfo(Environment.CurrentDirectory);
        while (workingDirectory != null)
        {
            var packageJson = Path.Combine(workingDirectory.FullName, "package.json");
            var scriptsDir = Path.Combine(workingDirectory.FullName, "scripts");
            if (File.Exists(packageJson) && Directory.Exists(scriptsDir))
            {
                return workingDirectory.FullName;
            }
            workingDirectory = workingDirectory.Parent;
        }

        throw new DirectoryNotFoundException("无法定位包含 package.json 和 scripts 目录的项目根目录。");
    }

    private static string EscapePowerShellSingleQuoted(string value)
    {
        return value.Replace("'", "''");
    }

    private sealed record LauncherCommand(string Label, string Command, string Description);
}
