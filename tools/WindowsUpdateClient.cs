using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace StrongholdProtocol.UpdateClient
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UpdateForm());
        }
    }

    internal sealed class FileEntry
    {
        public string Path;
        public long Size;
        public string Sha256;
    }

    internal sealed class UpdateManifest
    {
        public string FromVersion;
        public string ToVersion;
        public List<FileEntry> BaseFiles;
        public List<FileEntry> TargetFiles;
        public List<FileEntry> ChangedFiles;
        public List<string> RemovedFiles;

        public static UpdateManifest Load(string path)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Int32.MaxValue;
            Dictionary<string, object> root = serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
            if (root == null || ReadString(root, "format") != "stronghold-windows-update-v1") throw new InvalidDataException("不支持的 Windows 更新包。");
            Dictionary<string, object> from = ReadObject(root, "from");
            Dictionary<string, object> to = ReadObject(root, "to");
            UpdateManifest manifest = new UpdateManifest();
            manifest.FromVersion = ReadString(from, "version");
            manifest.ToVersion = ReadString(to, "version");
            manifest.BaseFiles = ReadEntries(root, "baseFiles");
            manifest.TargetFiles = ReadEntries(root, "targetFiles");
            manifest.ChangedFiles = ReadEntries(root, "changed");
            manifest.RemovedFiles = ReadStrings(root, "removed");
            return manifest;
        }

        private static Dictionary<string, object> ReadObject(Dictionary<string, object> value, string key)
        {
            object output;
            if (!value.TryGetValue(key, out output) || !(output is Dictionary<string, object>)) throw new InvalidDataException("更新包缺少 " + key + ".");
            return (Dictionary<string, object>)output;
        }

        private static string ReadString(Dictionary<string, object> value, string key)
        {
            object output;
            return value.TryGetValue(key, out output) && output != null ? Convert.ToString(output, CultureInfo.InvariantCulture) : "";
        }

        private static List<FileEntry> ReadEntries(Dictionary<string, object> value, string key)
        {
            object output;
            List<FileEntry> entries = new List<FileEntry>();
            if (!value.TryGetValue(key, out output) || output == null) return entries;
            IEnumerable values = output as IEnumerable;
            if (values == null) throw new InvalidDataException("更新包中的以下内容无效：" + key + " 列表。");
            foreach (object item in values)
            {
                Dictionary<string, object> file = item as Dictionary<string, object>;
                if (file == null) throw new InvalidDataException("更新包包含无效的文件条目。");
                entries.Add(new FileEntry { Path = ReadString(file, "path"), Size = Convert.ToInt64(file["size"], CultureInfo.InvariantCulture), Sha256 = ReadString(file, "sha256") });
            }
            return entries;
        }

        private static List<string> ReadStrings(Dictionary<string, object> value, string key)
        {
            object output;
            List<string> values = new List<string>();
            if (!value.TryGetValue(key, out output) || output == null) return values;
            IEnumerable source = output as IEnumerable;
            if (source == null) throw new InvalidDataException("更新包中的以下内容无效：" + key + " 列表。");
            foreach (object item in source) values.Add(Convert.ToString(item, CultureInfo.InvariantCulture));
            return values;
        }
    }

    internal sealed class UpdateForm : Form
    {
        private readonly string packageDirectory;
        private readonly UpdateManifest manifest;
        private readonly TextBox targetBox;
        private readonly Button browseButton;
        private readonly Button updateButton;
        private readonly Label summaryLabel;
        private readonly Label statusLabel;
        private readonly ProgressBar progress;
        private readonly TextBox log;

        public UpdateForm()
        {
            packageDirectory = AppDomain.CurrentDomain.BaseDirectory;
            manifest = UpdateManifest.Load(Path.Combine(packageDirectory, "update.json"));
            Text = "Stronghold Protocol 更新器";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new System.Drawing.Size(650, 420);
            Size = new System.Drawing.Size(760, 520);
            FormBorderStyle = FormBorderStyle.Sizable;

            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(18);
            layout.ColumnCount = 3;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            layout.RowCount = 6;
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(layout);

            Label title = new Label();
            title.Text = "Stronghold Protocol 客户端更新";
            title.AutoSize = true;
            title.Font = new System.Drawing.Font(Font.FontFamily, 14.0f, System.Drawing.FontStyle.Bold);
            title.Margin = new Padding(0, 0, 0, 12);
            layout.SetColumnSpan(title, 3);
            layout.Controls.Add(title, 0, 0);

            summaryLabel = new Label();
            summaryLabel.AutoSize = true;
            summaryLabel.Text = string.Format(CultureInfo.InvariantCulture, "{0} → {1}    新增或替换 {2} 个文件，删除 {3} 个文件", manifest.FromVersion, manifest.ToVersion, manifest.ChangedFiles.Count, manifest.RemovedFiles.Count);
            summaryLabel.Margin = new Padding(0, 0, 0, 14);
            layout.SetColumnSpan(summaryLabel, 3);
            layout.Controls.Add(summaryLabel, 0, 1);

            Label targetLabel = new Label();
            targetLabel.Text = "已安装客户端目录：";
            targetLabel.AutoSize = true;
            targetLabel.Anchor = AnchorStyles.Left;
            layout.Controls.Add(targetLabel, 0, 2);

            targetBox = new TextBox();
            targetBox.ReadOnly = true;
            targetBox.Dock = DockStyle.Fill;
            targetBox.Margin = new Padding(8, 3, 8, 3);
            layout.Controls.Add(targetBox, 1, 2);

            browseButton = new Button();
            browseButton.Text = "选择目录...";
            browseButton.AutoSize = true;
            browseButton.Click += delegate { SelectTarget(); };
            layout.Controls.Add(browseButton, 2, 2);

            statusLabel = new Label();
            statusLabel.Text = "请选择已安装的客户端目录，然后开始更新。";
            statusLabel.AutoSize = true;
            statusLabel.Margin = new Padding(0, 14, 0, 4);
            layout.SetColumnSpan(statusLabel, 3);
            layout.Controls.Add(statusLabel, 0, 3);

            log = new TextBox();
            log.Multiline = true;
            log.ReadOnly = true;
            log.ScrollBars = ScrollBars.Vertical;
            log.Dock = DockStyle.Fill;
            log.BackColor = System.Drawing.SystemColors.Window;
            layout.SetColumnSpan(log, 3);
            layout.Controls.Add(log, 0, 4);

            progress = new ProgressBar();
            progress.Style = ProgressBarStyle.Marquee;
            progress.MarqueeAnimationSpeed = 0;
            progress.Dock = DockStyle.Fill;
            progress.Margin = new Padding(0, 12, 8, 0);
            layout.Controls.Add(progress, 0, 5);
            layout.SetColumnSpan(progress, 2);

            updateButton = new Button();
            updateButton.Text = "更新客户端";
            updateButton.AutoSize = true;
            updateButton.Enabled = false;
            updateButton.Margin = new Padding(0, 12, 0, 0);
            updateButton.Click += delegate { StartUpdate(); };
            layout.Controls.Add(updateButton, 2, 5);
        }

        private void SelectTarget()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择已有的 Stronghold Protocol 客户端目录";
                dialog.ShowNewFolderButton = false;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                targetBox.Text = dialog.SelectedPath;
                updateButton.Enabled = true;
                Report("已选择：" + dialog.SelectedPath);
            }
        }

        private void StartUpdate()
        {
            string target = targetBox.Text;
            if (!Directory.Exists(target)) return;
            DialogResult choice = MessageBox.Show(this, "继续前请先关闭 Stronghold Protocol 客户端。所选目录将从 " + manifest.FromVersion + " 更新至 " + manifest.ToVersion + ".", "确认更新", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
            if (choice != DialogResult.OK) return;
            browseButton.Enabled = false;
            updateButton.Enabled = false;
            progress.MarqueeAnimationSpeed = 30;
            Task.Factory.StartNew(delegate
            {
                try
                {
                    ApplyUpdate(target);
                    FinishSuccess();
                }
                catch (Exception error)
                {
                    FinishFailure(error);
                }
            });
        }

        private void ApplyUpdate(string target)
        {
            Report("正在校验客户端 " + manifest.FromVersion + "...");
            VerifyFileSet(target, manifest.BaseFiles, "原客户端");
            Report("正在删除 " + manifest.RemovedFiles.Count + " 个文件...");
            foreach (string relative in manifest.RemovedFiles)
            {
                string path = SafeChild(target, relative);
                if (File.Exists(path)) File.Delete(path);
            }
            Report("正在复制 " + manifest.ChangedFiles.Count + " 个文件...");
            foreach (FileEntry entry in manifest.ChangedFiles)
            {
                string source = SafeChild(Path.Combine(packageDirectory, "files"), entry.Path);
                string destination = SafeChild(target, entry.Path);
                if (!File.Exists(source)) throw new InvalidDataException("更新包缺少文件：" + entry.Path + ".");
                string directory = Path.GetDirectoryName(destination);
                if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
                File.Copy(source, destination, true);
                if (!String.Equals(Sha256(destination), entry.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("已复制文件的哈希不匹配：" + entry.Path);
            }
            Report("正在校验客户端 " + manifest.ToVersion + "...");
            VerifyFileSet(target, manifest.TargetFiles, "更新后的客户端");
        }

        private void VerifyFileSet(string root, List<FileEntry> expectedEntries, string label)
        {
            HashSet<string> expected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (FileEntry entry in expectedEntries)
            {
                expected.Add(Normalize(entry.Path));
                string path = SafeChild(root, entry.Path);
                if (!File.Exists(path)) throw new InvalidDataException(label + " 缺少文件：" + entry.Path + ".");
                FileInfo info = new FileInfo(path);
                if (info.Length != entry.Size) throw new InvalidDataException(label + " 文件大小不正确：" + entry.Path);
                if (!String.Equals(Sha256(path), entry.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException(label + " 文件哈希不正确：" + entry.Path);
            }
            foreach (string file in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
            {
                string relative = file.Substring(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (!expected.Contains(Normalize(relative))) throw new InvalidDataException(label + " 包含未预期的文件：" + relative);
            }
        }

        private static string Normalize(string relative)
        {
            return relative.Replace('\\', '/');
        }

        private static string SafeChild(string root, string relative)
        {
            string normalized = Normalize(relative);
            if (String.IsNullOrWhiteSpace(normalized) || Path.IsPathRooted(normalized) || normalized == ".." || normalized.Contains("../")) throw new InvalidDataException("不安全的更新路径：" + relative);
            string basePath = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string path = Path.GetFullPath(Path.Combine(basePath, normalized));
            if (!path.StartsWith(basePath + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("更新路径越出了客户端目录：" + relative);
            return path;
        }

        private static string Sha256(string path)
        {
            using (SHA256 algorithm = SHA256.Create())
            using (FileStream stream = File.OpenRead(path))
            {
                byte[] hash = algorithm.ComputeHash(stream);
                StringBuilder output = new StringBuilder(hash.Length * 2);
                foreach (byte part in hash) output.Append(part.ToString("x2", CultureInfo.InvariantCulture));
                return output.ToString();
            }
        }

        private void Report(string text)
        {
            if (InvokeRequired)
            {
                BeginInvoke((Action<string>)Report, text);
                return;
            }
            statusLabel.Text = text;
            log.AppendText(text + Environment.NewLine);
        }

        private void FinishSuccess()
        {
            if (InvokeRequired)
            {
                BeginInvoke((Action)FinishSuccess);
                return;
            }
            progress.MarqueeAnimationSpeed = 0;
            Report("更新完成：" + manifest.FromVersion + " → " + manifest.ToVersion);
            MessageBox.Show(this, "客户端已成功更新。", "更新完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
        }

        private void FinishFailure(Exception error)
        {
            if (InvokeRequired)
            {
                BeginInvoke((Action<Exception>)FinishFailure, error);
                return;
            }
            progress.MarqueeAnimationSpeed = 0;
            browseButton.Enabled = true;
            updateButton.Enabled = !String.IsNullOrWhiteSpace(targetBox.Text);
            Report("更新已停止：" + error.Message);
            MessageBox.Show(this, error.Message, "更新失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}



