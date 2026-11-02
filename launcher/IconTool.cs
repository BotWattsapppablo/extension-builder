using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;

// Builds app-icon.ico: the same purple "M" tile the app shows in its header,
// at every size Windows asks for.
class IconTool
{
    static readonly int[] Sizes = new int[] { 16, 24, 32, 48, 64, 128, 256 };

    [STAThread]
    static int Main(string[] args)
    {
        string outPath = args.Length > 0 ? args[0] : "app-icon.ico";
        List<byte[]> blobs = new List<byte[]>();
        foreach (int size in Sizes) blobs.Add(Draw(size));

        using (FileStream fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
        using (BinaryWriter w = new BinaryWriter(fs))
        {
            w.Write((ushort)0);            // reserved
            w.Write((ushort)1);            // icon type
            w.Write((ushort)Sizes.Length); // image count
            uint offset = (uint)(6 + 16 * Sizes.Length);
            for (int i = 0; i < Sizes.Length; i++)
            {
                int s = Sizes[i];
                w.Write((byte)(s >= 256 ? 0 : s));
                w.Write((byte)(s >= 256 ? 0 : s));
                w.Write((byte)0);          // palette colours
                w.Write((byte)0);          // reserved
                w.Write((ushort)1);        // colour planes
                w.Write((ushort)32);       // bits per pixel
                w.Write((uint)blobs[i].Length);
                w.Write(offset);
                offset += (uint)blobs[i].Length;
            }
            foreach (byte[] b in blobs) w.Write(b);
        }
        Console.WriteLine("wrote " + outPath + " (" + new FileInfo(outPath).Length + " bytes, " + Sizes.Length + " sizes)");
        return 0;
    }

    static byte[] Draw(int size)
    {
        using (Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                float pad = size * 0.06f;
                RectangleF tile = new RectangleF(pad, pad, size - pad * 2, size - pad * 2);
                float radius = size * 0.22f;

                using (GraphicsPath path = Rounded(tile, radius))
                using (LinearGradientBrush bg = new LinearGradientBrush(
                    new RectangleF(tile.X, tile.Y, tile.Width, tile.Height),
                    Color.FromArgb(154, 124, 92, 255), Color.FromArgb(255, 74, 47, 214), 45f))
                {
                    g.FillPath(bg, path);
                }

                // the book spine notch: two soft white bars behind the letter
                using (SolidBrush glow = new SolidBrush(Color.FromArgb(60, 255, 255, 255)))
                {
                    g.FillRectangle(glow, tile.X + tile.Width * 0.16f, tile.Y + tile.Height * 0.18f,
                        tile.Width * 0.68f, tile.Height * 0.64f);
                }

                using (Font f = new Font("Segoe UI", size * 0.52f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (SolidBrush white = new SolidBrush(Color.White))
                {
                    StringFormat sf = new StringFormat();
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    g.DrawString("M", f, white, new RectangleF(tile.X, tile.Y - size * 0.02f, tile.Width, tile.Height), sf);
                }
            }
            using (MemoryStream ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }
    }

    static GraphicsPath Rounded(RectangleF r, float radius)
    {
        GraphicsPath p = new GraphicsPath();
        float d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}
