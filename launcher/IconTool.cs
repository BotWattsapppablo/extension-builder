using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;

// Builds app-icon.ico from the app's own artwork (app/icon.png), at every size
// Windows asks for. The master already has real alpha; this only scales it and
// leaves a little air around the drawing so it does not touch the tile edges.
class IconTool
{
    static readonly int[] Sizes = new int[] { 16, 24, 32, 48, 64, 128, 256 };

    [STAThread]
    static int Main(string[] args)
    {
        string outPath = args.Length > 0 ? args[0] : "app-icon.ico";
        string source = args.Length > 1 ? args[1] : null;
        if (source == null || !File.Exists(source))
        {
            Console.Error.WriteLine("icon artwork not found: " + source);
            return 1;
        }
        Bitmap master;
        using (Bitmap loaded = new Bitmap(source)) master = new Bitmap(loaded);

        List<byte[]> blobs = new List<byte[]>();
        foreach (int size in Sizes) blobs.Add(Draw(master, size));

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

    static byte[] Draw(Bitmap master, int size)
    {
        using (Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                // Windows draws icons flush against the tile, so the artwork
                // keeps a margin of its own or it reads as cropped.
                float pad = size * 0.04f;
                g.DrawImage(master, new RectangleF(pad, pad, size - pad * 2, size - pad * 2),
                    new RectangleF(0, 0, master.Width, master.Height), GraphicsUnit.Pixel);
            }
            using (MemoryStream ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }
    }
}
