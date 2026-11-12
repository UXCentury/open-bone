package com.openbone.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.openbone.runtime.Earcut;
import com.openbone.runtime.Json;
import com.openbone.runtime.JsNum;
import com.openbone.runtime.OpenBoneInstance;
import com.openbone.runtime.ParticleEmitter;
import com.openbone.runtime.Template;
import com.openbone.runtime.data.DocumentLoader;
import com.openbone.runtime.data.FontAsset;
import com.openbone.runtime.data.OpenBoneDocument;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Porting traps from docs/runtime-spec.md §12 that the suite only covers indirectly. */
class UnitTest {
  private static byte[] resource(String name) throws IOException {
    try (InputStream in = UnitTest.class.getResourceAsStream(name)) {
      return in.readAllBytes();
    }
  }

  @Test
  void jsNumberStrings() {
    assertEquals("0.1", JsNum.toString(0.1));
    assertEquals("1e+21", JsNum.toString(1e21));
    assertEquals("123456789012345680000", JsNum.toString(123456789012345678901.0));
    assertEquals("1e-7", JsNum.toString(1e-7));
    assertEquals("0.000001", JsNum.toString(1e-6));
    assertEquals("-2.5", JsNum.toString(-2.5));
    assertEquals("3", JsNum.toFixed(2.5, 0));
    assertEquals("1.01", JsNum.toFixed(1.005 + 1e-12, 2));
    assertEquals("1.00", JsNum.toFixed(1.005, 2)); // 1.005 is 1.00499999… in binary
    assertEquals(0.42, JsNum.roundPrecision((float) 0.42, 7));
  }

  @Test
  void templates() {
    Map<String, Object> v = new HashMap<>();
    v.put("m", 2.349);
    v.put("n", 12345.5);
    v.put("s", "hi");
    v.put("b", true);
    assertEquals("2.35x", Template.format("{m:0.00}x", v::get));
    assertEquals("$12,345.50", Template.format("{n:$#,##0.00}", v::get));
    assertEquals("+235%", Template.format("{m:+0%}", v::get));
    assertEquals("hi true {missing} {", Template.format("{s} {b} {missing} {{", v::get));
    assertEquals(".35", Template.formatNumber(0.349, "#.##"));
    assertEquals("0.333333", Template.plain(1.0 / 3));
  }

  @Test
  void rngMatchesMulberry32() {
    // Values printed by the TypeScript Rng(1) / hashString / earcut.
    ParticleEmitter.Rng r = new ParticleEmitter.Rng(1);
    assertEquals(0.6270739405881613, r.next(), 0);
    assertEquals(0.002735721180215478, r.next(), 0);
    assertEquals(0x4d22c733L, Integer.toUnsignedLong(ParticleEmitter.hashString("fx")));
  }

  @Test
  void earcutSquareAndConcave() {
    assertEquals("[2, 3, 0, 2, 0, 1]", java.util.Arrays.toString(Earcut.triangulate(new double[] {0, 0, 10, 0, 10, 10, 0, 10})));
    int[] t = Earcut.triangulate(new double[] {10, 0, 0, 50, 60, 60, 70, 10});
    assertEquals("[1, 0, 3, 1, 3, 2]", java.util.Arrays.toString(t));
  }

  /** .obonb decoding (float32 → 7 significant digits) matches deserializeBinary in the TypeScript core. */
  @Test
  void binaryDocumentsDecodeLikeTypeScript() throws IOException {
    for (String name : new String[] {"transforms", "walker"}) {
      Object mine = DocumentLoader.decodeBinary(resource("/binary/" + name + ".obonb"));
      Object ts = Json.parse(new String(resource("/binary/" + name + ".decoded.json"), StandardCharsets.UTF_8));
      int n = sameTree(name, mine, ts);
      assertTrue(n > 100, "compared " + n + " values");
      OpenBoneDocument doc = DocumentLoader.load(resource("/binary/" + name + ".obonb"));
      OpenBoneInstance inst = new OpenBoneInstance(doc);
      inst.play(doc.animations.get(0).name, true);
      for (int i = 0; i < 30; i++) inst.advance(1 / 60.0);
      assertTrue(!inst.drawList().isEmpty());
    }
  }

  /** Document fonts load from .obone and .obonb alike, and match by family (any case) and closest weight. */
  @Test
  void documentFonts() throws IOException {
    for (String file : new String[] {"fonts.obone", "fonts.obonb"}) {
      OpenBoneDocument doc = DocumentLoader.load(resource("/fonts/" + file));
      assertEquals(3, doc.fonts.size(), file);
      FontAsset regular = doc.fonts.get(0), bold = doc.fonts.get(1), light = doc.fonts.get(2);
      assertEquals("f1", regular.id);
      assertEquals("Brand Regular", regular.name);
      assertEquals("Brand Sans", regular.family);
      assertEquals("data:font/ttf;base64,AAEAAAALAIAAAwAw", regular.src, file);
      assertEquals(400, regular.weight);
      assertEquals("normal", regular.style);
      assertEquals("fonts/BrandSans-Bold.ttf", bold.src);
      assertEquals(700, bold.weight);
      assertEquals(300, light.weight);
      assertEquals("italic", light.style);
      assertEquals(regular, doc.findFont("brand sans", 400));
      assertEquals(regular, doc.findFont(" BRAND SANS ", 500));
      assertEquals(bold, doc.findFont("Brand Sans", 600));
      assertEquals(bold, doc.findFont("Brand Sans", 900));
      assertEquals(light, doc.findFont("Brand Sans", 100));
      assertNull(doc.findFont("Georgia", 400));
    }
    assertTrue(DocumentLoader.fromJson("{\"format\":\"openbone\",\"version\":1}").fonts.isEmpty());
  }

  @SuppressWarnings("unchecked")
  private static int sameTree(String path, Object mine, Object ts) {
    if (mine instanceof Map) {
      int n = 0;
      Map<String, Object> m = (Map<String, Object>) mine, t = (Map<String, Object>) ts;
      for (Map.Entry<String, Object> e : m.entrySet()) {
        if (!t.containsKey(e.getKey())) throw new AssertionError(path + "." + e.getKey() + " missing in TypeScript decode");
        n += sameTree(path + "." + e.getKey(), e.getValue(), t.get(e.getKey()));
      }
      return n;
    }
    if (mine instanceof List) {
      List<Object> m = (List<Object>) mine, t = (List<Object>) ts;
      assertEquals(t.size(), m.size(), path);
      int n = 0;
      for (int i = 0; i < m.size(); i++) n += sameTree(path + "[" + i + "]", m.get(i), t.get(i));
      return n;
    }
    if (mine instanceof Double) assertEquals((Double) ts, (Double) mine, 0, path);
    else assertEquals(ts, mine, path);
    return 1;
  }
}
