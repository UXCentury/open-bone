package com.openbone.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.util.AttributeSet
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import com.openbone.runtime.AudioCommand
import com.openbone.runtime.DrawItem
import com.openbone.runtime.FiredEvent
import com.openbone.runtime.OpenBoneInstance
import com.openbone.runtime.ScriptHost
import com.openbone.runtime.StateMachineInstance
import com.openbone.runtime.data.DocumentLoader
import com.openbone.runtime.data.OpenBoneDocument
import com.openbone.scripting.QuickJsScriptHost
import kotlin.math.max
import kotlin.math.min

/**
 * Plays an OpenBone document: a state machine (inputs, pointer listeners from touch, scripts) or plain animations,
 * drawn with [CanvasRenderer] and advanced on the display's frame clock while attached and [isPlaying].
 *
 * ```kotlin
 * val view = OpenBoneView(context)
 * view.load(assets.open("knight/knight.obone").readBytes(), ImageSource.assets(assets, "knight"))
 * view.useStateMachine("knight")
 * view.onEvent { e -> if (e.name == "footstep") playStep() }
 * view.onStateChange { layer, from, to -> Log.d("anim", "$layer: $from → $to") }
 * view["walk"] = true          // set an input (bool, number or string)
 * view.fire("jump")            // fire a trigger
 * ```
 */
open class OpenBoneView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
  defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {

  /** How the artboard fits the view. */
  enum class Fit { CONTAIN, COVER, FILL, NONE }

  var fit: Fit = Fit.CONTAIN
    set(value) {
      field = value
      invalidate()
    }

  /** Engine for state machine scripts (QuickJS by default; null disables scripts). Set before [load]. */
  var scriptHost: ScriptHost? = QuickJsScriptHost()

  /** Time multiplier. */
  var speed: Double = 1.0

  /** Whether time advances (the view still redraws while paused). */
  var isPlaying: Boolean = true
    set(value) {
      field = value
      if (value) scheduleFrame()
    }

  var instance: OpenBoneInstance? = null
    private set
  var document: OpenBoneDocument? = null
    private set
  val stateMachine: StateMachineInstance? get() = instance?.stateMachine

  private var renderer: CanvasRenderer? = null
  private val toView = Matrix()
  private val toSkeleton = Matrix()
  private val point = FloatArray(2)
  private var lastFrameNanos = 0L
  private var frameScheduled = false

  private val eventHandlers = ArrayList<(FiredEvent) -> Unit>()
  private val stateHandlers = ArrayList<(layer: String, from: String?, to: String) -> Unit>()
  private val audioHandlers = ArrayList<(AudioCommand) -> Unit>()

  /** Called for every animation key, listener and script event. */
  fun onEvent(handler: (FiredEvent) -> Unit) = apply { eventHandlers += handler }

  /** Called when a state machine layer changes state. */
  fun onStateChange(handler: (layer: String, from: String?, to: String) -> Unit) = apply { stateHandlers += handler }

  /** Sound commands (play/stop/fade) for your audio backend, e.g. SoundPool or ExoPlayer. */
  fun onAudio(handler: (AudioCommand) -> Unit) = apply { audioHandlers += handler }

  /** Load a .obone / .obonb document from bytes. */
  fun load(bytes: ByteArray, images: ImageSource = ImageSource.embedded) = load(DocumentLoader.load(bytes), images)

  /** Load a document. Images (and atlas pages) are read through [images]. */
  fun load(doc: OpenBoneDocument, images: ImageSource = ImageSource.embedded) = apply {
    instance?.dispose()
    renderer?.release()
    document = doc
    renderer = CanvasRenderer(doc, images)
    instance = OpenBoneInstance(doc, scriptHost).also { inst ->
      inst.addListener(object : OpenBoneInstance.Listener {
        override fun event(e: FiredEvent) = eventHandlers.forEach { it(e) }
        override fun stateChange(layer: String, from: String?, to: String) = stateHandlers.forEach { it(layer, from, to) }
        override fun audio(c: AudioCommand) = audioHandlers.forEach { it(c) }
      })
    }
    lastFrameNanos = 0
    instance?.advance(0.0)
    invalidate()
    scheduleFrame()
  }

  /** Run a state machine (by name or id; null = the document's first). */
  fun useStateMachine(name: String? = null): StateMachineInstance {
    val inst = requireNotNull(instance) { "Call load() first" }
    return inst.useStateMachine(name).also {
      inst.advance(0.0)
      invalidate()
    }
  }

  /** Play an animation on a track (stops the state machine). */
  fun play(animation: String, loop: Boolean = true, track: Int = 0) {
    val inst = requireNotNull(instance) { "Call load() first" }
    inst.play(animation, loop, track)
    inst.advance(0.0)
    invalidate()
  }

  /** Set the skin by name or id (null = none). */
  fun setSkin(skin: String?) {
    instance?.skeleton?.setSkin(skin)
    invalidate()
  }

  /** Current value of a state machine input (Double, Boolean or String). */
  operator fun get(input: String): Any? = stateMachine?.getInput(input)

  /** Set a state machine input; a trigger input fires. */
  operator fun set(input: String, value: Any) {
    stateMachine?.setInput(input, if (value is Number) value.toDouble() else value)
  }

  fun fire(trigger: String) {
    stateMachine?.fire(trigger)
  }

  /** Show fixed text (or a template) in a slot's text attachment; null restores the attachment's own. */
  fun setText(slot: String, text: String?) {
    instance?.skeleton?.setText(slot, text)
    invalidate()
  }

  /** Step time manually (also when not [isPlaying]). */
  fun advance(seconds: Double) {
    instance?.advance(seconds)
    invalidate()
  }

  // ---------------- Frame loop ----------------

  private val frameCallback = Choreographer.FrameCallback { now ->
    frameScheduled = false
    if (!isAttachedToWindow || !isPlaying) return@FrameCallback
    val dt = if (lastFrameNanos == 0L) 0.0 else min((now - lastFrameNanos) / 1e9, 0.1)
    lastFrameNanos = now
    instance?.advance(dt * speed)
    invalidate()
    scheduleFrame()
  }

  private fun scheduleFrame() {
    if (frameScheduled || !isAttachedToWindow || !isPlaying || instance == null) return
    frameScheduled = true
    Choreographer.getInstance().postFrameCallback(frameCallback)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    lastFrameNanos = 0
    scheduleFrame()
  }

  override fun onDetachedFromWindow() {
    Choreographer.getInstance().removeFrameCallback(frameCallback)
    frameScheduled = false
    super.onDetachedFromWindow()
  }

  /** Stop sounds and scripts and free bitmaps. The view can be loaded again afterwards. */
  fun release() {
    instance?.dispose()
    renderer?.release()
    instance = null
    renderer = null
  }

  // ---------------- Drawing ----------------

  private fun updateMatrix() {
    val doc = document ?: return
    val aw = if (doc.width > 0) doc.width.toFloat() else 800f
    val ah = if (doc.height > 0) doc.height.toFloat() else 600f
    val w = (width - paddingLeft - paddingRight).toFloat()
    val h = (height - paddingTop - paddingBottom).toFloat()
    toView.reset()
    // Skeleton space (y up, origin at originX/originY of the artboard) → artboard pixels (y down).
    toView.setValues(floatArrayOf(1f, 0f, doc.originX.toFloat(), 0f, -1f, doc.originY.toFloat(), 0f, 0f, 1f))
    var sx = w / aw
    var sy = h / ah
    when (fit) {
      Fit.CONTAIN -> min(sx, sy).let { sx = it; sy = it }
      Fit.COVER -> max(sx, sy).let { sx = it; sy = it }
      Fit.NONE -> { sx = 1f; sy = 1f }
      Fit.FILL -> Unit
    }
    toView.postScale(sx, sy)
    toView.postTranslate(paddingLeft + (w - aw * sx) / 2, paddingTop + (h - ah * sy) / 2)
    toView.invert(toSkeleton)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val inst = instance ?: return
    updateMatrix()
    renderer?.draw(canvas, inst.drawList(), toView)
  }

  /** The current draw list (for custom rendering). */
  fun drawList(): List<DrawItem> = instance?.drawList() ?: emptyList()

  /** Skeleton space → view pixels. */
  fun skeletonToView(x: Float, y: Float): FloatArray {
    updateMatrix()
    point[0] = x
    point[1] = y
    toView.mapPoints(point)
    return floatArrayOf(point[0], point[1])
  }

  /** View pixels → skeleton space. */
  fun viewToSkeleton(x: Float, y: Float): FloatArray {
    updateMatrix()
    point[0] = x
    point[1] = y
    toSkeleton.mapPoints(point)
    return floatArrayOf(point[0], point[1])
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    val inst = instance ?: return false
    if (inst.stateMachine == null) return super.onTouchEvent(event)
    val type = when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> "down"
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> "up"
      MotionEvent.ACTION_MOVE -> "move"
      else -> return true
    }
    val p = viewToSkeleton(event.x, event.y)
    if (type == "down") inst.pointer("move", p[0].toDouble(), p[1].toDouble()) // enter listeners see the pointer arrive
    inst.pointer(type, p[0].toDouble(), p[1].toDouble())
    if (type == "up") performClick()
    return true
  }

  override fun performClick(): Boolean = super.performClick()

  override fun onGenericMotionEvent(event: MotionEvent): Boolean {
    // Mouse / stylus hover (Chromebooks, desktop mode) drives enter/exit/move listeners.
    if (event.actionMasked == MotionEvent.ACTION_HOVER_MOVE) {
      val inst = instance ?: return false
      val p = viewToSkeleton(event.x, event.y)
      inst.pointer("move", p[0].toDouble(), p[1].toDouble())
      return true
    }
    return super.onGenericMotionEvent(event)
  }
}
