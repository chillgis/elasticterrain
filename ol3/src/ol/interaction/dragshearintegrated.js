goog.provide('ol.interaction.DragShearIntegrated');

goog.require('goog.asserts');
goog.require('goog.async.AnimationDelay');
goog.require('ol.Pixel');
goog.require('ol.coordinate');
goog.require('ol.events.condition');
goog.require('ol.interaction.Pointer');
goog.require('ol.ViewHint');

/** @typedef {{map:ol.Map,
 threshold:number,
 springCoefficient:number,
 frictionForce:number,
 maxInnerShearingPx: number,
 maxOuterShearingPx: number,
 staticShearFadeOutAnimationSpeed: number,
 criticalElevationThreshold: number}} */
ol.interaction.DragShearIntegratedOptions;


/**
 * @classdesc
 * Terrain Interaction DragShearIntegrated
 *
 * @constructor
 * @extends {ol.interaction.Pointer}
 * @param {ol.interaction.DragShearIntegratedOptions} options
 * @param {ol.Map} map
 * @param {ol.events.ConditionType} condition
 * @api stable
 */
ol.interaction.DragShearIntegrated = function(options,map,condition) {
	goog.base(this, {
		handleDownEvent : ol.interaction.DragShearIntegrated.handleDownEvent_,
		handleDragEvent : ol.interaction.DragShearIntegrated.handleDragEvent_,
		handleUpEvent : ol.interaction.DragShearIntegrated.handleUpEvent_
	});

  /**
   * Shearing Interaction State
   * @enum {number}
   */
  ol.interaction.State = {
    NO_SHEARING: 0,
    STATIC_SHEARING: 1,
    HYBRID_SHEARING: 2,
    ANIMATION_AFTER_STATIC_SHEARING: 3
  };

	/** @type {ol.interaction.DragShearIntegratedOptions} */
	this.options;
	this.setOptions(options);

	goog.asserts.assertInstanceof(map, ol.Map, 'dragShearIntegrated expects map object');

	/** @type {ol.Map} */
	this.map = map;

	/** @type {ol.View} */
	this.view = this.map.getView();

	/** @type {ol.layer.TileDem} */
	this.demLayer = /** @type {ol.layer.TileDem} */(this.map.getLayers().getArray()[this.map.getLayers().getArray().length - 1]);

	/** @type {ol.renderer.webgl.TileDemLayer} */
	this.demRenderer = /** @type {ol.renderer.webgl.TileDemLayer} */(this.map.getRenderer().getLayerRenderer(this.demLayer));

	/** @type {ol.events.ConditionType} */
	this.condition = goog.isDef(condition['keypress']) ? condition['keypress'] : ol.events.condition.noModifierKeys;

	/** @type {number} */
	this.springLength = 0;

	/** @type {ol.Pixel} */
	this.startDragPositionPx = [0, 0];

	/** @type {number|null} */
	this.startDragElevation = 0;

 	/** @type {number} */
  	this.criticalElevationThreshold = this.options.criticalElevationThreshold;

	/** @type {number} */
	this.minElevation = 0;

	/** @type {number} */
	this.maxElevation = 0;

	/** @type {number} */
	this.criticalElevation = 0;

	/** @type {ol.Pixel} */
	this.startCenter = [0, 0];

	/** @type {ol.Pixel} */
	this.currentCenter = [0, 0];

	/** @type {number}
	 * Horizontal speed of the terrain animation [meters per second]
	 */
	this.vx_t_1 = 0;

	/** @type {number}
	 * Vertical speed of the terrain animation [meters per second]
	 */
	this.vy_t_1 = 0;

	/** @type {ol.Pixel} */
	this.currentDragPositionPx = [0, 0];

	/** @type {Date}
	 * Time when last rendering occured. Used to measure FPS and adjust shearing speed accordingly. */
	this.lastRenderTime = null;

	/** @type {number}
	 * Distance between current mouse position and point being animated [meters].*/
	this.distanceX = 0;

	/** @type {number}
	 * Distance between current mouse position and point being animated [meters] */
	this.distanceY = 0;

	/** @type {number} */
	this.shearingStatus = ol.interaction.State.NO_SHEARING;


  /**
   * Apply shearing to model and trigger rendering
   * @param {number} shearX
   * @param {number} shearY   
   * @this {ol.interaction.DragShearIntegrated}
   */
  ol.interaction.DragShearIntegrated.prototype.shear = function(shearX, shearY) {
    this.demLayer.setTerrainShearing({
      x : shearX,
      y : shearY
    });
    this.demLayer.redraw();
  };

	/**
	 * Animates shearing & panning according to currentDragPositionPx
	 */
	ol.interaction.DragShearIntegrated.prototype.animation = function() {
		var
		// mouse position [meters]
		currentDragPosition = this.map.getCoordinateFromPixel(this.currentDragPositionPx),
		// position of drag start [meters]
		    startDragPosition = this.map.getCoordinateFromPixel(this.startDragPositionPx),
		// position of point that is animated [meters]. Compensate for shifted map center.
		    animatingPositionX = startDragPosition[0] - (this.currentCenter[0] - this.startCenter[0]),
		    animatingPositionY = startDragPosition[1] - (this.currentCenter[1] - this.startCenter[1]);

		// Distance between current mouse position and point being animated [meters].
		// This distance is also needed for fading out animation when the mouse is released after a static
		// shear. The annimation wiggles the mountains back to the start drag position. There
		// are no drag events during this animation that would adjust currentDragPositionPx, so we
		// use the previous distanceX and distanceY during the animation.
		if (this.shearingStatus !== ol.interaction.State.ANIMATION_AFTER_STATIC_SHEARING) {
			this.distanceX = currentDragPosition[0] - animatingPositionX;
			this.distanceY = currentDragPosition[1] - animatingPositionY;
		}
		var distance = Math.sqrt(this.distanceX * this.distanceX + this.distanceY * this.distanceY),
		// spring lengths along the two axes [meters]
		    springLengthX = distance > 0 ? this.distanceX / distance * this.springLength : 0,
		    springLengthY = distance > 0 ? this.distanceY / distance * this.springLength : 0,
		// spring coefficient // FIXME: passed springCoefficient paramter should be 60 times larger
		    k = this.options['springCoefficient'] * 60,
		// friction for damping previous speed
		    friction = 1 - this.options['frictionForce'],
		// stretch or compression of the spring
		    springStretchX = this.distanceX - springLengthX,
		    springStretchY = this.distanceY - springLengthY,
		// current velocity of animation [meters per second]
		    vx_t0 = k * springStretchX + friction * this.vx_t_1,
		    vy_t0 = k * springStretchY + friction * this.vy_t_1,
		// time since last frame was rendered [seconds]
		    currentTime = new Date(),
		    dTsec = this.lastRenderTime !== null ? (currentTime.getTime() - this.lastRenderTime.getTime()) / 1000 : 1 / 60,
		// displacement of clicked point due to spring [meters]
		    dx = vx_t0 * dTsec,
		    dy = vy_t0 * dTsec;

		// store values for next rendered frame
		this.lastRenderTime = currentTime;
		this.vx_t_1 = vx_t0;
		this.vy_t_1 = vy_t0;

		if (this.shearingStatus === ol.interaction.State.ANIMATION_AFTER_STATIC_SHEARING) {
			// map center is not moved during animation following static shearing
			dx *= this.options['staticShearFadeOutAnimationSpeed'];
			dy *= this.options['staticShearFadeOutAnimationSpeed'];
		} else {
			// shift map center
			this.currentCenter[0] -= dx;
			this.currentCenter[1] -= dy;
		}

		// Test for end of animation: stop animation when speed and acceleration of the animation are close to zero.
		// The acceleration is triggered by the spring, and is proportional to the stretch of the spring.
		// The stretch is the length by which the spring differs from its resting position.
		var springStretch = Math.sqrt(springStretchX * springStretchX + springStretchY * springStretchY),
		// acceleration
		    a = k * springStretch / dTsec,
		// velocity
		    v = Math.sqrt(vx_t0 * vx_t0 + vy_t0 * vy_t0),
		// minimum distance
		    dTol = this.options['threshold'] * this.view.getResolution(),
		// minimum velocity
		    vTol = dTol / dTsec,
		// minimum acceleration
		    aTol = vTol / dTsec / 100, // 100 is an empirical factor
		    stopAnimation = this.shearingStatus !== ol.interaction.State.STATIC_SHEARING && a < aTol && v < vTol;
		//if (this.shearingStatus === ol.interaction.State.ANIMATION_AFTER_STATIC_SHEARING) {
		//	console.log("FPS", Math.round(1 / dTsec), "v", Math.round(v), "\tvTol", Math.round(vTol), "\ta", Math.round(a), "\taTol", Math.round(aTol));
		//}

		// Recompute distances after the new velocity is applied.
		this.distanceX -= dx;
		this.distanceY -= dy;

		// test for other active interactions like zooming or rotation
		var otherInteractionActive = this.view.getHints()[ol.ViewHint.INTERACTING];

		if (stopAnimation || otherInteractionActive) {
			console.log("stop");
			// stop the animation
			this.animationDelay.stop();
			this.lastRenderTime = null;
			this.distanceX = this.distanceY = 0;
			this.vx_t_1 = this.vy_t_1 = 0;
      this.shear(0,0);            
			this.shearingStatus = ol.interaction.State.NO_SHEARING;
		} else {
			// compute shearing distance
			var shearX = this.distanceX,
			    shearY = this.distanceY;

			// if pointer is between the inner and the outer circle, limit shearing to the radius of the inner circle.
			if (this.shearingStatus === ol.interaction.State.STATIC_SHEARING) {
				var shearLength = Math.sqrt(this.distanceX * this.distanceX + this.distanceY * this.distanceY);
				if (shearLength > this.options['maxInnerShearingPx'] * this.view.getResolution()) {
					shearX = (this.distanceX / shearLength) * this.options['maxInnerShearingPx'] * this.view.getResolution();
					shearY = (this.distanceY / shearLength) * this.options['maxInnerShearingPx'] * this.view.getResolution();
				}
			}

			if (this.startDragElevation > this.criticalElevation) {
				// high elevations
				this.shear(shearX / this.startDragElevation, shearY / this.startDragElevation);
				if ((Math.abs(dx) > dTol || Math.abs(dy) > dTol) && this.shearingStatus !== ol.interaction.State.ANIMATION_AFTER_STATIC_SHEARING) {
					this.view.setCenter([this.currentCenter[0], this.currentCenter[1]]);
				}
			} else {
				// low elevations
				this.shear(-shearX / (this.maxElevation - this.startDragElevation), -shearY / (this.maxElevation - this.startDragElevation));
				// make low elevation point stay under cursor
				// FIXME add similar test as for high elevations and only call setCenter if necessary?
				this.view.setCenter([this.currentCenter[0] - this.distanceX, this.currentCenter[1] - this.distanceY]);
			}

			// trigger the next frame rendering
			this.animationDelay.start();
		}
	};

	/**
	 * @private
	 * @type {goog.async.AnimationDelay}
	 */
	this.animationDelay = new goog.async.AnimationDelay(this.animation, undefined, this);
	this.registerDisposable(this.animationDelay);
};

goog.inherits(ol.interaction.DragShearIntegrated, ol.interaction.Pointer);

/**
 * @param {ol.MapBrowserPointerEvent} mapBrowserEvent Event.
 * @this {ol.interaction.DragShearIntegrated}
 */

ol.interaction.DragShearIntegrated.handleDragEvent_ = function(mapBrowserEvent) {
	if (this.targetPointers.length > 0 && this.condition(mapBrowserEvent)) {
		goog.asserts.assert(this.targetPointers.length >= 1);

		this.currentDragPositionPx = ol.interaction.Pointer.centroid(this.targetPointers);

		if (this.shearingStatus === ol.interaction.State.STATIC_SHEARING) {
			// position of drag start in meters
			var currentDragPosition = this.map.getCoordinateFromPixel(this.currentDragPositionPx),
			    startDragPosition = this.map.getCoordinateFromPixel(this.startDragPositionPx),
			// position of point that is animated
			    animatingPositionX = startDragPosition[0] - (this.currentCenter[0] - this.startCenter[0]),
			    animatingPositionY = startDragPosition[1] - (this.currentCenter[1] - this.startCenter[1]),
			// distance between current mouse position and point being animated
			    distanceX = currentDragPosition[0] - animatingPositionX,
			    distanceY = currentDragPosition[1] - animatingPositionY,
			    distance = Math.sqrt(distanceX * distanceX + distanceY * distanceY),
			    maxOuterShearingMeters = this.options['maxOuterShearingPx'] * this.view.getResolution();

			// set spring length equal to drag distance
			this.springLength = Math.min(maxOuterShearingMeters, distance);

			// switch from static shearing to hybrid shearing if the pointer is leaving the outer circle.
			if (distance >= maxOuterShearingMeters) {
				this.springLength = 0;
				this.shearingStatus = ol.interaction.State.HYBRID_SHEARING;
			}
		}
		this.animationDelay.start();
	}
};

/**
 * @param {ol.MapBrowserPointerEvent} mapBrowserEvent Event.
 * @return {boolean} Stop drag sequence?
 * @this {ol.interaction.DragShearIntegrated}
 * @private
 */
ol.interaction.DragShearIntegrated.handleUpEvent_ = function(mapBrowserEvent) {
	if (this.targetPointers.length === 0) {
		if (this.shearingStatus === ol.interaction.State.STATIC_SHEARING) {
			this.shearingStatus = ol.interaction.State.ANIMATION_AFTER_STATIC_SHEARING;
			this.springLength = 0;
		}
		return true;
	}
	return false;
};

/**
 * @param {ol.MapBrowserPointerEvent} mapBrowserEvent Event.
 * @return {boolean} Start drag sequence?
 * @this {ol.interaction.DragShearIntegrated}
 * @private
 */
ol.interaction.DragShearIntegrated.handleDownEvent_ = function(mapBrowserEvent) {
	// console.log("inner circle radius", this.options['maxInnerShearingPx']);
	// console.log("outer circle radius", this.options['maxOuterShearingPx']);
	// console.log("wiggling threshold", this.options['threshold']);
	// console.log("spring constant", this.options['springCoefficient']);
	// console.log("velocity friction coefficient", this.options['frictionForce']);

	var minMax,
	    mapCenter;
	if (this.targetPointers.length > 0 && this.condition(mapBrowserEvent)) {

		minMax = this.demRenderer.getCurrentMinMax();
		this.minElevation = minMax[0];
		this.maxElevation = minMax[1];
    	// critical elevation value to seperate minima and maxima
		this.criticalElevation = this.minElevation + (this.maxElevation - this.minElevation) * this.options['criticalElevationThreshold'];
		mapCenter = this.view.getCenter();
		this.startDragPositionPx = ol.interaction.Pointer.centroid(this.targetPointers);
		this.startDragElevation = this.demRenderer.getElevation(mapBrowserEvent.coordinate, this.view.getZoom());
		this.startCenter = [mapCenter[0], mapCenter[1]];
		this.currentCenter = [mapCenter[0], mapCenter[1]];
		this.currentDragPositionPx = ol.interaction.Pointer.centroid(this.targetPointers);
		this.shearingStatus = ol.interaction.State.STATIC_SHEARING;
		this.animationDelay.stop();
		this.lastRenderTime = null;
		this.distanceX = this.distanceY = 0;
		this.vx_t_1 = this.vy_t_1 = 0;

		return true;
	}
	return false;
};

/**
 * Enable animations related this interaction
 */
ol.interaction.DragShearIntegrated.prototype.enable = function() {
	this.view.setHint(ol.ViewHint.INTERACTING, -1);
};
goog.exportProperty(ol.interaction.DragShearIntegrated.prototype, 'enable', ol.interaction.DragShearIntegrated.prototype.enable);

/**
 * Disable animations related this interaction
 */
ol.interaction.DragShearIntegrated.prototype.disable = function() {
	if (!this.view.getHints()[ol.ViewHint.INTERACTING])
		this.view.setHint(ol.ViewHint.INTERACTING, 1);
};
goog.exportProperty(ol.interaction.DragShearIntegrated.prototype, 'disable', ol.interaction.DragShearIntegrated.prototype.disable);

/**
 * Set options
 * @param {ol.interaction.DragShearIntegratedOptions} options
 */
ol.interaction.DragShearIntegrated.prototype.setOptions = function(options) {
	goog.asserts.assert(goog.isDef(options.threshold));
	goog.asserts.assert(goog.isDef(options.springCoefficient));
	goog.asserts.assert(goog.isDef(options.frictionForce));
	goog.asserts.assert(goog.isDef(options.maxInnerShearingPx));
	goog.asserts.assert(goog.isDef(options.maxOuterShearingPx));
    goog.asserts.assert(goog.isDef(options.staticShearFadeOutAnimationSpeed));
    goog.asserts.assert(goog.isDef(options.criticalElevationThreshold));
	this.options = options;
};
goog.exportProperty(ol.interaction.DragShearIntegrated.prototype, 'setOptions', ol.interaction.DragShearIntegrated.prototype.setOptions);
