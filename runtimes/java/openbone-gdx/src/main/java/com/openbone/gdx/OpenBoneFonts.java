package com.openbone.gdx;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.files.FileHandle;
import com.badlogic.gdx.graphics.Color;
import com.badlogic.gdx.graphics.g2d.BitmapFont;
import com.badlogic.gdx.graphics.g2d.freetype.FreeType;
import com.badlogic.gdx.graphics.g2d.freetype.FreeTypeFontGenerator;
import com.badlogic.gdx.utils.Disposable;
import com.openbone.runtime.data.FontAsset;
import com.openbone.runtime.data.OpenBoneDocument;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Fonts for OpenBone text attachments, through FreeType. A text's font is a CSS family list ("Noto Serif JP, Georgia,
 * serif"); each family is looked up in the fonts you {@link #register registered} (including the document's own
 * fonts, {@link #registerDocument}; of several files for a family, the one whose weight is closest to the text's),
 * then among the installed system fonts (fontconfig on Linux, the font folders on Windows, macOS and Android), and the first one that has every
 * character of the text wins, so Japanese text skips a Latin-only family. Glyphs are rasterised on demand, so large
 * scripts cost only the characters used.
 *
 *
 * <p>Needs the gdx-freetype natives for your platform; {@link #isAvailable()} is false without them.
 */
public class OpenBoneFonts implements Disposable {
  /** Glyphs are rasterised at this multiple of the text size, so text stays sharp when the view is zoomed in. */
  public float oversample = 2f;

  private final Map<String, List<Registered>> registered = new HashMap<>();
  private final Map<String, Face> resolved = new HashMap<>();
  private final Map<String, BitmapFont> fonts = new HashMap<>();
  private final Map<String, FreeTypeFontGenerator> generators = new HashMap<>();
  private FreeType.Library library;
  private final Map<String, FreeType.Face> faces = new HashMap<>();

  /** A font file and the face inside it (collections such as .ttc hold several). */
  public static final class Face {
    public final FileHandle file;
    public final int index;

    public Face(FileHandle file, int index) {
      this.file = file;
      this.index = index;
    }

    String key() {
      return file.path() + "#" + index;
    }
  }

  private static final class Registered {
    final FileHandle file;
    final double weight;
    final boolean italic;

    Registered(FileHandle file, double weight, boolean italic) {
      this.file = file;
      this.weight = weight;
      this.italic = italic;
    }
  }

  /** Whether FreeType's natives loaded (false: use a BitmapFont instead). */
  public static boolean isAvailable() {
    try {
      FreeType.Library lib = FreeType.initFreeType();
      lib.dispose();
      return true;
    } catch (Throwable e) {
      return false;
    }
  }

  /** Use this file for a family name (as written in the document, any case), before looking at system fonts. */
  public OpenBoneFonts register(String family, FileHandle file) {
    return register(family, file, 400, false);
  }

  /**
   * Add a file to a family (any case) at a weight (100..900) and style. Texts of that family use the registered file
   * whose weight is closest to theirs (on a tie, the upright one, then the first registered); a file registered again
   * replaces the one at the same weight and style.
   */
  public OpenBoneFonts register(String family, FileHandle file, double weight, boolean italic) {
    List<Registered> list = registered.computeIfAbsent(family.trim().toLowerCase(Locale.ROOT), k -> new ArrayList<>());
    list.removeIf(r -> r.weight == weight && r.italic == italic);
    list.add(new Registered(file, weight, italic));
    resolved.clear();
    return this;
  }

  /**
   * Register the fonts a document carries ({@code doc.fonts}), so its text looks the same as in the editor whatever is
   * installed. {@code data:} sources are written to temporary files; paths are relative to {@code base} (the
   * document's folder; null = internal files). Fonts that can't be read are skipped (logged).
   */
  public OpenBoneFonts registerDocument(OpenBoneDocument doc, FileHandle base) {
    for (FontAsset f : doc.fonts) {
      if (f.family == null || f.family.trim().isEmpty()) continue;
      try {
        FileHandle file = fontFile(f.src, base);
        if (file != null) register(f.family, file, f.weight, "italic".equals(f.style));
        else if (Gdx.app != null) Gdx.app.error("OpenBone", "Cannot find font \"" + f.name + "\" (" + abbreviate(f.src) + ")");
      } catch (Exception e) {
        if (Gdx.app != null) Gdx.app.error("OpenBone", "Cannot load font \"" + f.name + "\": " + e.getMessage());
      }
    }
    return this;
  }

  private static String abbreviate(String src) {
    return src == null ? "" : src.length() > 60 ? src.substring(0, 60) + "…" : src;
  }

  /** The file of a font source: {@code data:} URLs go to a temporary file (FreeType reads fonts from files). */
  protected FileHandle fontFile(String src, FileHandle base) throws IOException {
    if (src == null || src.isEmpty()) return null;
    if (src.startsWith("data:")) {
      int comma = src.indexOf(',');
      if (comma < 0 || !src.substring(0, comma).endsWith(";base64")) return null;
      String mime = src.substring(5, comma).toLowerCase(Locale.ROOT);
      String ext = mime.contains("otf") || mime.contains("opentype") ? ".otf" : mime.contains("woff") ? ".woff" : ".ttf";
      File tmp = File.createTempFile("openbone-font", ext);
      tmp.deleteOnExit();
      FileHandle f = Gdx.files.absolute(tmp.getAbsolutePath());
      f.writeBytes(Base64.getMimeDecoder().decode(src.substring(comma + 1)), false);
      return f;
    }
    FileHandle f = base != null ? base.child(src) : Gdx.files.internal(src);
    if (!f.exists()) f = Gdx.files.absolute(src);
    return f.exists() ? f : null;
  }

  /**
   * The font for a text: `families` is the document's CSS list and `size` the text size. `outline` > 0 gives a font
   * whose glyphs are FreeType borders only (transparent fill; its advances are wider than the plain font's, so lay
   * text out with the plain font). Tint with setColor.
   */
  public BitmapFont font(String families, String text, float size, float outline) {
    return font(families, text, size, 400, outline);
  }

  /** {@link #font(String, String, float, float)} for a text weight (picks among registered files of a family). */
  public BitmapFont font(String families, String text, float size, double weight, float outline) {
    Face face = faceFor(families, text, weight);
    if (face == null) return null;
    int px = Math.max(4, Math.round(size * oversample));
    float border = outline * oversample;
    String key = face.key() + "|" + px + "|" + border;
    BitmapFont f = fonts.get(key);
    if (f != null) return f;
    FreeTypeFontGenerator gen = generators.get(face.key());
    if (gen == null) {
      gen = new FreeTypeFontGenerator(face.file, face.index);
      generators.put(face.key(), gen);
    }
    FreeTypeFontGenerator.FreeTypeFontParameter p = new FreeTypeFontGenerator.FreeTypeFontParameter();
    p.size = px;
    p.incremental = true; // rasterise characters as they're first drawn
    p.minFilter = com.badlogic.gdx.graphics.Texture.TextureFilter.Linear;
    p.magFilter = com.badlogic.gdx.graphics.Texture.TextureFilter.Linear;
    p.hinting = FreeTypeFontGenerator.Hinting.None;
    if (border > 0) {
      p.borderWidth = border;
      p.borderColor = Color.WHITE;
      p.borderStraight = false;
      p.color = new Color(1, 1, 1, 0);
    }
    f = gen.generateFont(p);
    f.setUseIntegerPositions(false);
    fonts.put(key, f);
    return f;
  }

  /** The first family in the list that is installed (or registered) and has every character of `text`. */
  public Face faceFor(String families, String text) {
    return faceFor(families, text, 400);
  }

  /** {@link #faceFor(String, String)} for a text weight. */
  public Face faceFor(String families, String text, double weight) {
    String key = families + "\u0000" + weight + "\u0000" + uniqueChars(text);
    if (resolved.containsKey(key)) return resolved.get(key);
    Face first = null, best = null;
    for (String fam : splitFamilies(families)) {
      Face face = lookup(fam, weight);
      if (face == null) continue;
      if (first == null) first = face;
      if (covers(face, text)) {
        best = face;
        break;
      }
    }
    if (best == null) best = first;
    if (best == null) best = lookup("sans-serif", weight);
    resolved.put(key, best);
    return best;
  }

  static List<String> splitFamilies(String families) {
    List<String> out = new ArrayList<>();
    if (families == null) return out;
    for (String part : families.split(",")) {
      String n = part.trim();
      if (n.length() >= 2 && (n.charAt(0) == '"' || n.charAt(0) == '\'') && n.charAt(n.length() - 1) == n.charAt(0)) n = n.substring(1, n.length() - 1);
      if (!n.isEmpty()) out.add(n);
    }
    return out;
  }

  private static String uniqueChars(String s) {
    StringBuilder b = new StringBuilder();
    s.codePoints().distinct().sorted().forEach(b::appendCodePoint);
    return b.toString();
  }

  private boolean covers(Face face, String text) {
    try {
      FreeType.Face f = faces.get(face.key());
      if (f == null) {
        if (library == null) library = FreeType.initFreeType();
        f = library.newFace(face.file, face.index);
        faces.put(face.key(), f);
      }
      final FreeType.Face ft = f;
      return text.codePoints().allMatch(c -> Character.isWhitespace(c) || ft.getCharIndex(c) != 0);
    } catch (Throwable e) {
      return false;
    }
  }

  private static final String[] GENERIC = {"serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace"};

  private static boolean generic(String fam) {
    for (String g : GENERIC) if (g.equals(fam)) return true;
    return false;
  }

  private Face lookup(String family, double weight) {
    String fam = family.toLowerCase(Locale.ROOT);
    List<Registered> regs = registered.get(fam);
    if (regs != null && !regs.isEmpty()) {
      Registered best = null;
      double bestScore = Double.MAX_VALUE;
      for (Registered r : regs) {
        double score = Math.abs(r.weight - weight) * 2 + (r.italic ? 1 : 0);
        if (score < bestScore) {
          best = r;
          bestScore = score;
        }
      }
      return new Face(best.file, 0);
    }
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    boolean android = System.getProperty("java.vendor", "").toLowerCase(Locale.ROOT).contains("android");
    if (!android && os.contains("linux")) return fontconfig(family, fam);
    return scanFolders(fam, os, android);
  }

  /** Linux: ask fontconfig, and accept its answer only when it is that family (it always answers something). */
  private static Face fontconfig(String family, String fam) {
    String query = fam.equals("system-ui") || fam.startsWith("ui-sans") ? "sans-serif" : fam.equals("ui-serif") ? "serif" : fam.equals("ui-monospace") ? "monospace" : family;
    try {
      Process p = new ProcessBuilder("fc-match", "-f", "%{family}\\n%{file}\\n%{index}\\n", query).redirectErrorStream(true).start();
      List<String> lines = new ArrayList<>();
      try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
        for (String l; (l = r.readLine()) != null; ) lines.add(l);
      }
      p.waitFor(5, TimeUnit.SECONDS);
      if (lines.size() < 3) return null;
      boolean match = generic(fam);
      for (String name : lines.get(0).split(",")) if (name.trim().equalsIgnoreCase(family)) match = true;
      if (!match) return null;
      File file = new File(lines.get(1));
      if (!file.isFile()) return null;
      int index = 0;
      try {
        index = Integer.parseInt(lines.get(2).trim());
      } catch (NumberFormatException ignored) {
      }
      return new Face(Gdx.files.absolute(file.getPath()), index);
    } catch (Exception e) {
      return null;
    }
  }

  /** Windows, macOS and Android: font files whose names start with the family name (spaces and dashes ignored). */
  private static Face scanFolders(String fam, String os, boolean android) {
    List<String> dirs = new ArrayList<>();
    String home = System.getProperty("user.home", "");
    if (android) dirs.add("/system/fonts");
    else if (os.contains("win")) {
      String win = System.getenv("WINDIR");
      dirs.add((win != null ? win : "C:\\Windows") + "\\Fonts");
      String local = System.getenv("LOCALAPPDATA");
      if (local != null) dirs.add(local + "\\Microsoft\\Windows\\Fonts");
    } else {
      dirs.add("/System/Library/Fonts");
      dirs.add("/System/Library/Fonts/Supplemental");
      dirs.add("/Library/Fonts");
      dirs.add(home + "/Library/Fonts");
    }
    String[] names;
    switch (fam) {
      case "serif":
      case "ui-serif":
        names = android ? new String[] {"notoserif"} : os.contains("win") ? new String[] {"times", "georgia"} : new String[] {"times", "georgia"};
        break;
      case "monospace":
      case "ui-monospace":
        names = android ? new String[] {"droidsansmono", "cutive"} : os.contains("win") ? new String[] {"consola", "cour"} : new String[] {"menlo", "courier"};
        break;
      case "sans-serif":
      case "system-ui":
      case "ui-sans-serif":
        names = android ? new String[] {"roboto"} : os.contains("win") ? new String[] {"segoeui", "arial"} : new String[] {"helvetica", "arial"};
        break;
      default:
        names = new String[] {fam.replaceAll("[\\s\\-_]", "")};
    }
    for (String want : names) {
      for (String d : dirs) {
        File[] files = new File(d).listFiles();
        if (files == null) continue;
        File hit = null;
        for (File f : files) {
          String n = f.getName().toLowerCase(Locale.ROOT);
          if (!(n.endsWith(".ttf") || n.endsWith(".otf") || n.endsWith(".ttc"))) continue;
          String bare = n.replaceAll("[\\s\\-_]", "");
          if (!bare.startsWith(want)) continue;
          // Prefer the regular face over bold / italic files of the same family.
          if (hit == null || bare.contains("regular") || hit.getName().length() > f.getName().length() && !hit.getName().toLowerCase(Locale.ROOT).contains("regular")) hit = f;
        }
        if (hit != null) return new Face(Gdx.files.absolute(hit.getPath()), 0);
      }
    }
    return null;
  }

  @Override
  public void dispose() {
    for (BitmapFont f : fonts.values()) f.dispose();
    for (FreeTypeFontGenerator g : generators.values()) g.dispose();
    for (FreeType.Face f : faces.values()) f.dispose();
    if (library != null) library.dispose();
    fonts.clear();
    generators.clear();
    faces.clear();
    resolved.clear();
  }
}
