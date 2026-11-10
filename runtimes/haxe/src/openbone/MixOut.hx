package openbone;

import openbone.data.Model;

/**
	How an animation being faded out is applied during a cross-fade: its blending timelines that none of `into` key use
	`alpha` (the outgoing weight, 1 - mix) instead of the full weight, so they ease back to the pose underneath (the setup
	pose on the first track / layer) instead of holding and snapping when the fade ends.
**/
class MixOut {
	public var into:Array<AnimationData>;
	public var alpha:Float;

	public function new(into:Array<AnimationData>, alpha:Float) {
		this.into = into;
		this.alpha = alpha;
	}
}
