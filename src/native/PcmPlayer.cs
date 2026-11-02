using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// A block's unmanaged memory survives until WHDR_DONE or waveOutReset.
public static class NaturalVoicePcmPlayer {
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct Format {
        public ushort Tag, Channels;
        public uint Rate, BytesPerSecond;
        public ushort Align, Bits, Extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Header {
        public IntPtr Data;
        public uint Length, Recorded;
        public IntPtr User;
        public uint Flags, Loops;
        public IntPtr Next, Reserved;
    }
    [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr device, uint id, ref Format format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutUnprepareHeader(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutReset(IntPtr device);
    [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr device);
    class Block { public IntPtr Data, Header; public bool Prepared, Submitted; }
    public class Command {
        public string op { get; set; }
        public string job { get; set; }
        public string data { get; set; }
        public int seq { get; set; }
        public int rate { get; set; }
        public int channels { get; set; }
    }
    static readonly object Gate = new object(), Output = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
    static readonly AutoResetEvent DeviceEvent = new AutoResetEvent(false);
    static readonly List<Block> Blocks = new List<Block>();
    static readonly uint HeaderSize = (uint)Marshal.SizeOf(typeof(Header));
    static IntPtr Device;
    static Format CurrentFormat;
    static string Job;
    static bool Started, Ended, Closing;
    static long Received, GapAt, GapTotal, MaxGap, StartedAt;
    static int GapCount;

    static void Send(object value) { lock (Output) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    static long Time() { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; }
    static void Check(uint result) { if (result != 0) throw new InvalidOperationException("waveOut error " + result); }
    static void FinishGap() {
        if (GapAt == 0) return;
        long gap = Time() - GapAt;
        if (gap >= 25) { GapCount++; GapTotal += gap; MaxGap = Math.Max(MaxGap, gap); }
        GapAt = 0;
    }
    static void Release(Block block) {
        if (block.Prepared) Check(waveOutUnprepareHeader(Device, block.Header, HeaderSize));
        Marshal.FreeHGlobal(block.Header); Marshal.FreeHGlobal(block.Data);
    }
    static void Reset() {
        if (Device != IntPtr.Zero) Check(waveOutReset(Device));
        foreach (Block block in Blocks) Release(block);
        Blocks.Clear(); Job = null; Started = false; Ended = false; GapAt = 0;
    }
    static void Begin(Command command) {
        if (Job != null) throw new InvalidOperationException("A stream is already active");
        if (command.rate < 8000 || command.rate > 192000 || (command.channels != 1 && command.channels != 2)) throw new InvalidOperationException("Invalid PCM format");
        if (Device != IntPtr.Zero && (CurrentFormat.Rate != command.rate || CurrentFormat.Channels != command.channels)) {
            Check(waveOutClose(Device)); Device = IntPtr.Zero;
        }
        if (Device == IntPtr.Zero) {
            CurrentFormat = new Format { Tag = 1, Channels = (ushort)command.channels, Rate = (uint)command.rate, BytesPerSecond = (uint)(command.rate * command.channels * 2), Align = (ushort)(command.channels * 2), Bits = 16 };
            Check(waveOutOpen(out Device, 0xffffffff, ref CurrentFormat, DeviceEvent.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, 0x00050000));
        }
        Job = command.job; Received = 0; Started = false; Ended = false;
        GapAt = GapTotal = MaxGap = 0; GapCount = 0; StartedAt = 0;
    }
    static void SubmitPending() {
        bool submitted = false;
        foreach (Block block in Blocks) {
            if (block.Submitted) continue;
            Check(waveOutPrepareHeader(Device, block.Header, HeaderSize)); block.Prepared = true;
            Check(waveOutWrite(Device, block.Header, HeaderSize)); block.Submitted = true; submitted = true;
        }
        if (submitted) FinishGap();
        if (submitted && !Started) { Started = true; StartedAt = Time(); Send(new { ev = "started", job = Job }); }
    }
    static void Append(Command command) {
        if (command.job != Job) return;
        if (Ended) throw new InvalidOperationException("Stream already ended");
        byte[] pcm = Convert.FromBase64String(command.data ?? "");
        if (pcm.Length == 0 || pcm.Length % CurrentFormat.Align != 0 || Received + pcm.Length > 16 * 1024 * 1024) throw new InvalidOperationException("Invalid PCM block size");
        Block block = new Block();
        block.Data = Marshal.AllocHGlobal(pcm.Length);
        try {
            Marshal.Copy(pcm, 0, block.Data, pcm.Length);
            block.Header = Marshal.AllocHGlobal((int)HeaderSize);
            Marshal.StructureToPtr(new Header { Data = block.Data, Length = (uint)pcm.Length }, block.Header, false);
            Blocks.Add(block); Received += pcm.Length;
        } catch { if (block.Header != IntPtr.Zero) Marshal.FreeHGlobal(block.Header); Marshal.FreeHGlobal(block.Data); throw; }
        // 300ms prebuffer, flushed by End for short utterances.
        if (Started || Received >= CurrentFormat.BytesPerSecond * 3 / 10) SubmitPending();
        Send(new { ev = "queued", job = Job, seq = command.seq });
    }
    static void Drain() {
        for (int i = Blocks.Count - 1; i >= 0; i--) {
            Block block = Blocks[i];
            if (!block.Submitted) continue;
            Header header = (Header)Marshal.PtrToStructure(block.Header, typeof(Header));
            if ((header.Flags & 1) == 0) continue;
            Release(block); Blocks.RemoveAt(i);
        }
        if (Job == null || !Started || Blocks.Count != 0) return;
        if (!Ended) { if (GapAt == 0) GapAt = Time(); return; }
        string done = Job; Job = null; GapAt = 0;
        Send(new { ev = "done", job = done, bytes = Received, underflowCount = GapCount, underflowMs = GapTotal, maxGapMs = MaxGap, playbackMs = Time() - StartedAt, pid = Process.GetCurrentProcess().Id });
    }
    static void RunDrain() {
        while (!Closing) {
            DeviceEvent.WaitOne(10);
            lock (Gate) {
                if (Closing) return;
                try { Drain(); }
                catch (Exception) {
                    string failed = Job;
                    try { Reset(); } catch { Closing = true; }
                    Send(new { ev = "error", job = failed });
                }
            }
        }
    }
    public static void Run() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        Thread drain = new Thread(RunDrain); drain.IsBackground = true; drain.Start();
        Send(new { ev = "ready", pid = Process.GetCurrentProcess().Id });
        try {
            string line;
            while (!Closing && (line = Console.ReadLine()) != null) {
                if (line.Length == 0) continue;
                Command command = null;
                lock (Gate) {
                    try {
                        command = Json.Deserialize<Command>(line);
                        if (command.op == "begin") Begin(command);
                        else if (command.op == "data") Append(command);
                        else if (command.op == "end" && command.job == Job) { Ended = true; SubmitPending(); Drain(); }
                        else if (command.op == "stop") { if (command.job == Job) Reset(); Send(new { ev = "stopped", job = command.job }); }
                        else if (command.op == "shutdown") break;
                    } catch (Exception) {
                        string failed = command == null ? Job : command.job;
                        try { Reset(); } catch { Closing = true; }
                        Send(new { ev = "error", job = failed });
                    }
                }
            }
        } finally {
            lock (Gate) { Closing = true; try { Reset(); } finally { if (Device != IntPtr.Zero) waveOutClose(Device); Device = IntPtr.Zero; } }
            DeviceEvent.Set(); drain.Join(1000); DeviceEvent.Dispose();
        }
    }
}
