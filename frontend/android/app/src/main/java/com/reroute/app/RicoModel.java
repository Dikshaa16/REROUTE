package com.reroute.app;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Rico's ear: the small speech model "Hey Rico" is heard with, on the phone itself (Vosk's Indian English model,
 * Apache 2.0). It's downloaded once, when the traveller turns "Hey Rico" on (about 38 MB), and kept with the app's
 * files; nothing the microphone hears leaves the phone.
 */
final class RicoModel {

    static final String ADDRESS = "https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip";

    interface Progress {
        void at(int percent);
    }

    private RicoModel() {}

    static File dir(Context context) {
        return new File(context.getFilesDir(), "rico-ear");
    }

    static boolean ready(Context context) {
        File dir = dir(context);
        return new File(dir, ".ready").isFile() && new File(dir, "am/final.mdl").isFile();
    }

    /** Downloads and unpacks the model, unless it's here already. Blocks: call it off the main thread. */
    static synchronized void download(Context context, Progress progress) throws IOException {
        if (ready(context)) {
            progress.at(100);
            return;
        }
        File zip = new File(context.getCacheDir(), "rico-ear.zip");
        HttpURLConnection http = (HttpURLConnection) new URL(ADDRESS).openConnection();
        http.setConnectTimeout(15_000);
        http.setReadTimeout(30_000);
        try {
            int code = http.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("The model's server answered " + code);
            long total = http.getContentLengthLong();
            try (InputStream in = http.getInputStream(); OutputStream out = new FileOutputStream(zip)) {
                byte[] buffer = new byte[64 * 1024];
                long done = 0;
                int last = -1;
                for (int n; (n = in.read(buffer)) > 0; ) {
                    out.write(buffer, 0, n);
                    done += n;
                    // Downloading is most of the wait: up to 90%, unpacking the rest.
                    int percent = total > 0 ? (int) (done * 90 / total) : 0;
                    if (percent != last) {
                        last = percent;
                        progress.at(percent);
                    }
                }
            }
        } finally {
            http.disconnect();
        }
        File dir = dir(context);
        deleteTree(dir);
        if (!dir.mkdirs()) throw new IOException("Couldn't make the model's folder");
        unzip(zip, dir);
        //noinspection ResultOfMethodCallIgnored
        zip.delete();
        if (!new File(dir, ".ready").createNewFile() && !ready(context)) throw new IOException("The model didn't unpack");
        progress.at(100);
    }

    /** The zip's one top folder (vosk-model-…/) becomes `dir`; an entry naming a place outside it is refused. */
    private static void unzip(File zip, File dir) throws IOException {
        String root = dir.getCanonicalPath() + File.separator;
        try (ZipInputStream in = new ZipInputStream(new FileInputStream(zip))) {
            byte[] buffer = new byte[64 * 1024];
            for (ZipEntry entry; (entry = in.getNextEntry()) != null; ) {
                String name = entry.getName();
                int slash = name.indexOf('/');
                String inside = slash >= 0 ? name.substring(slash + 1) : name;
                if (inside.isEmpty()) continue;
                File target = new File(dir, inside);
                if (!target.getCanonicalPath().startsWith(root)) throw new IOException("The model's zip points outside its folder");
                if (entry.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    target.mkdirs();
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Couldn't unpack the model");
                try (OutputStream out = new FileOutputStream(target)) {
                    for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                }
            }
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
