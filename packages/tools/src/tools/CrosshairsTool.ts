import { vec2, vec3 } from 'gl-matrix';
import vtkMatrixBuilder from '@kitware/vtk.js/Common/Core/MatrixBuilder';

import type { Types } from '@cornerstonejs/core';
import {
  getEnabledElementByIds,
  getEnabledElement,
  Enums,
  CONSTANTS,
  utilities,
  triggerEvent,
  eventTarget,
} from '@cornerstonejs/core';
import type * as ToolTypes from '../types/index';

import * as ToolAnnotation from '../stateManagement/annotation/index';
import * as ToolUtilities from '../utilities/index';
import * as drawSvg from '../drawingSvg/index';
import AnnotationTool from '../tools/base/AnnotationTool';
import * as ToolStore from '../store/index';
import * as ToolCursors from '../cursors/index';
import state from '../store/state';
import * as ToolEnums from '../enums/index';

const { RENDERING_DEFAULTS } = CONSTANTS;

interface RotPoints {
  // coordinate in 3D of the point
  world: Types.Point3;
  viewportId: string;
  // coordinate in 2D of the axis containing the point
  pt1: Types.Point2;
  pt2: Types.Point2;
}

interface CrosshairsAnnotation extends ToolTypes.Annotation {
  data: {
    handles: {
      rotationPoints: RotPoints[]; // rotation handles, used for rotation interactions
      slabThicknessPoints: RotPoints[]; // slab thickness handles, used for setting the slab thickness
      activeOperation: OPERATION | null;
    };
    activeViewportIds: string[]; // a list of the viewport ids connected to the reference lines being translated
    viewportId: string;
  };
}

enum OPERATION {
  DRAG_LINE = 1,
  DRAG_CENTER,
  ROTATE,
  SLAB,
}

const trueProvider = (_viewportId: string) => true;

/**
 * CrosshairsTool is a tool that provides reference lines between different viewports
 * of a toolGroup. Using crosshairs, you can jump to a specific location in one
 * viewport and the rest of the viewports in the toolGroup will be aligned to that location.
 * Crosshairs have grababble handles that can be used to rotate and translate the
 * reference lines. They can also be used to set the slab thickness of the viewports
 * by modifying the slab thickness handles.
 *
 */
export default class CrosshairsTool extends AnnotationTool {
  static toolName: string;
  static {
    this.toolName = 'Crosshairs';
  }

  private _toolCenter: Types.Point3 = [0, 0, 0]; // NOTE: it is assumed that all the active/linked viewports share the same crosshair center.
  activeOperation: OPERATION | null = null;

  // This because the rotation operation rotates also all the other active/intersecting reference lines of the same angle
  _getReferenceLineColor: (viewportId: string) => string;
  _getReferenceLineRotatable: (viewportId: string) => boolean;
  _getReferenceLineDraggable: (viewportId: string) => boolean;
  _getReferenceLineSlabThicknessControlsOn: (viewportId: string) => boolean;
  editData: {
    annotation: CrosshairsAnnotation;
  } | null;

  constructor(
    toolProps: ToolTypes.PublicToolProps = {},
    defaultToolProps: ToolTypes.ToolProps = {
      supportedInteractionTypes: ['Mouse'],
      configuration: {
        shadow: true,
        // renders a colored circle on top right of the viewports whose color
        // matches the color of the reference line
        viewportIndicators: false,

        viewportIndicatorsConfig: {
          radius: 5,
          x: null,
          y: null,
        },
        // Auto pan is a configuration which will update pan
        // other viewports in the toolGroup if the center of the crosshairs
        // is outside of the viewport. This might be useful for the case
        // when the user is scrolling through an image (usually in the zoomed view)
        // and the crosshairs will eventually get outside of the viewport for
        // the other viewports.
        autoPan: {
          enabled: false,
          panSize: 10,
        },
        handleRadius: 3,
        // Enable HDPI rendering for handles using devicePixelRatio
        enableHDPIHandles: false,
        // radius of the area around the intersection of the planes, in which
        // the reference lines will not be rendered. This is only used when
        // having 3 viewports in the toolGroup.
        referenceLinesCenterGapRadius: 20,
        // actorUIDs for slabThickness application, if not defined, the slab thickness
        // will be applied to all actors of the viewport
        filterActorUIDsToSetSlabThickness: [],
        // blend mode for slabThickness modifications
        slabThicknessBlendMode: Enums.BlendModes.MAXIMUM_INTENSITY_BLEND,
        mobile: {
          enabled: false,
          opacity: 0.8,
          handleRadius: 9,
        },
        getReferenceLineColor: (_viewportId: string): string =>
          'rgb(0, 200, 0)',
        getReferenceLineControllable: trueProvider,
        getReferenceLineSlabThicknessControlsOn: trueProvider,
        getReferenceLineDraggable: trueProvider,
        getReferenceLineRotatable: trueProvider,
        forceOrthogonal: true,
      },
    }
  ) {
    super(toolProps, defaultToolProps);
    const finalConfig = utilities.deepMerge(
      defaultToolProps,
      toolProps
    ).configuration;
    this._getReferenceLineColor = finalConfig.getReferenceLineColor;
    this._getReferenceLineDraggable = finalConfig.getReferenceLineDraggable;
    this._getReferenceLineRotatable = finalConfig.getReferenceLineRotatable;
    this._getReferenceLineSlabThicknessControlsOn =
      finalConfig.getReferenceLineSlabThicknessControlsOn;
    this.editData = null;
  }

  /**
   * Gets the camera from the viewport, and adds crosshairs annotation for the viewport
   * to the annotationManager. If any annotation is found in the annotationManager, it
   * overwrites it.
   * @param viewportInfo - The viewportInfo for the viewport to add the crosshairs
   * @returns viewPlaneNormal and center of viewport canvas in world space
   */
  protected initializeViewport({
    renderingEngineId,
    viewportId,
  }: Types.IViewportId): {
    normal: Types.Point3;
    point: Types.Point3;
  } {
    const enabledElement = getEnabledElementByIds(
      viewportId,
      renderingEngineId
    );
    if (!enabledElement) {
      throw new Error(
        `No enabledElement found for the given viewportId (${viewportId}))`
      );
    }
    const { FrameOfReferenceUID, viewport } = enabledElement;
    const { element } = viewport;
    const { position, focalPoint, viewPlaneNormal } = viewport.getCamera();
    if (
      position === undefined ||
      focalPoint === undefined ||
      viewPlaneNormal === undefined
    ) {
      throw new Error('invalid camera');
    }

    // Check if there is already annotation for this viewport
    let annotations = this._getAnnotations(enabledElement);
    annotations = this.filterInteractableAnnotationsForElement(
      element,
      annotations
    );

    annotations.forEach((annotation) => {
      // If found, it will override it by removing the annotation and adding it later
      ToolAnnotation.state.removeAnnotation(annotation.annotationUID!);
    });

    const annotation = {
      highlighted: false,
      metadata: {
        cameraPosition: <Types.Point3>[...position],
        cameraFocalPoint: <Types.Point3>[...focalPoint],
        FrameOfReferenceUID,
        toolName: this.getToolName(),
      },
      data: {
        handles: {
          activeOperation: null, // 0 translation, 1 rotation handles, 2 slab thickness handles
          rotationPoints: [], // rotation handles, used for rotation interactions
          slabThicknessPoints: [], // slab thickness handles, used for setting the slab thickness
          toolCenter: this.toolCenter,
        },
        activeViewportIds: [], // a list of the viewport ids connected to the reference lines being translated
        viewportId,
      },
    };

    ToolAnnotation.state.addAnnotation(annotation, element);

    return {
      normal: viewPlaneNormal,
      point: viewport.canvasToWorld([
        viewport.canvas.clientWidth / 2,
        viewport.canvas.clientHeight / 2,
      ]),
    };
  }

  protected getViewportsInfo(): Types.IEnabledElement[] {
    const viewports = ToolStore.ToolGroupManager.getToolGroup(
      this.toolGroupId
    )!.viewportsInfo;

    return viewports
      .map(({ viewportId, renderingEngineId }) =>
        getEnabledElementByIds(viewportId, renderingEngineId)
      )
      .filter((viewportInfo) => viewportInfo !== undefined);
  }

  onSetToolActive() {
    const viewportsInfo = this.getViewportsInfo();

    // Upon new setVolumes on viewports we need to update the crosshairs
    // reference points in the new space, so we subscribe to the event
    // and update the reference points accordingly.
    this._unsubscribeToViewportNewVolumeSet(viewportsInfo);
    this._subscribeToViewportNewVolumeSet(viewportsInfo);

    this.initToolCenter();
  }

  onSetToolPassive() {
    this.initToolCenter();
  }

  onSetToolEnabled() {
    this.initToolCenter();
  }

  onSetToolDisabled() {
    const viewportsInfo = this.getViewportsInfo();

    this._unsubscribeToViewportNewVolumeSet(viewportsInfo);

    // Crosshairs annotations in the state
    // has no value when the tool is disabled
    // since viewports can change (zoom, pan, scroll)
    // between disabled and enabled/active states.
    // so we just remove the annotations from the state
    viewportsInfo.forEach((enabledElement) => {
      const annotations = this._getAnnotations(enabledElement);

      annotations.forEach((annotation) => {
        ToolAnnotation.state.removeAnnotation(annotation.annotationUID!);
      });
    });
  }

  resetCrosshairs = () => {
    const viewportsInfo = this.getViewportsInfo();
    for (const enabledElement of viewportsInfo) {
      const viewport = enabledElement.viewport as Types.IVolumeViewport;
      const resetPan = true;
      const resetZoom = true;
      const resetToCenter = true;
      const resetRotation = true;
      const suppressEvents = true;
      viewport.resetCamera({
        resetPan,
        resetZoom,
        resetToCenter,
        resetRotation,
        suppressEvents,
      });
      (viewport as Types.IVolumeViewport).resetSlabThickness();
      const { element } = viewport;
      let annotations = this._getAnnotations(enabledElement);
      annotations = this.filterInteractableAnnotationsForElement(
        element,
        annotations
      );
      if (annotations.length) {
        ToolAnnotation.state.removeAnnotation(annotations[0].annotationUID!);
      }
      viewport.render();
    }

    this.initToolCenter();
  };

  protected isWithinImageData(
    point: Types.Point3,
    data: Types.IImageData
  ): boolean {
    const idx = data.imageData.worldToIndex(point);
    const dims = data.imageData.getDimensions();
    return (
      idx[0] >= 0 &&
      idx[0] < dims[0] &&
      idx[1] >= 0 &&
      idx[1] < dims[1] &&
      idx[2] >= 0 &&
      idx[2] < dims[2]
    );
  }

  private preventRentyInSetToolCenter: boolean = false;

  protected get toolCenter(): Types.Point3 {
    return [this._toolCenter[0], this._toolCenter[1], this._toolCenter[2]];
  }

  public setToolCenter(
    center: Types.Point3,
    viewport: Types.IVolumeViewport | undefined = undefined,
    suppressEvents: boolean = false
  ) {
    if (this.preventRentyInSetToolCenter) {
      return;
    }
    this.preventRentyInSetToolCenter = true;
    const prevCenter = this.toolCenter;
    let nextCenter: Types.Point3 = [center[0], center[1], center[2]];
    let doTriggerEvent = false;
    try {
      if (viewport !== undefined) {
        // verify that center is within one (at least) of the volumes
        const datas = viewport
          .getAllVolumeIds()
          .map((volumeId) => viewport.getImageData(volumeId))
          .filter((imageData) => imageData !== undefined);
        if (
          undefined ===
          datas.find((data) => this.isWithinImageData(nextCenter, data!))
        ) {
          // try to move within each volume
          const r = datas
            .map((data) => {
              const idx = data!.imageData.worldToIndex(nextCenter);
              const dims = data!.imageData.getDimensions();
              for (let i = 0; i < 3; i++) {
                if (idx[i] < 0) {
                  idx[i] = 0;
                } else if (idx[i] >= dims[i]) {
                  idx[i] = dims[i] - 1;
                }
              }
              const candidate = data!.imageData.indexToWorld(idx);
              const score = datas.reduce((p: number, value): number => {
                return this.isWithinImageData(
                  [candidate[0], candidate[1], candidate[2]],
                  value!
                )
                  ? p + 1
                  : p;
              }, 0);
              return { score, candidate };
            })
            .sort((a, b) => a.score - b.score)[0];
          nextCenter = [r.candidate[0], r.candidate[1], r.candidate[2]];
        }
      } else {
        // make sure center is within any volume
        const viewportsInfo = this.getViewportsInfo();
        if (
          undefined ===
          viewportsInfo.find((v) => {
            const iv = <Types.IVolumeViewport>v.viewport;
            return (
              undefined !==
              iv
                .getAllVolumeIds()
                .find((id) =>
                  this.isWithinImageData(nextCenter, iv.getImageData(id)!)
                )
            );
          })
        ) {
          // reset to center of first volume
          const iv = <Types.IVolumeViewport>viewportsInfo[0].viewport;
          const data = iv.getImageData(iv.getAllVolumeIds()[0]);
          const dims = data!.imageData.getDimensions();
          const nCenter = data!.imageData.indexToWorld([
            dims[0] / 2,
            dims[1] / 2,
            dims[2] / 2,
          ]);
          nextCenter = [nCenter[0], nCenter[1], nCenter[2]];
        }
      }
      if (!vec3.equals(nextCenter, prevCenter)) {
        this._toolCenter = nextCenter;
        this.applyToolCenterChange();
        doTriggerEvent = !suppressEvents;
      }
    } finally {
      this.preventRentyInSetToolCenter = false;
    }
    if (doTriggerEvent) {
      triggerEvent(
        eventTarget,
        ToolEnums.Events.CROSSHAIR_TOOL_CENTER_CHANGED,
        {
          toolGroupId: this.toolGroupId,
          toolCenter: this.toolCenter,
        }
      );
    }
  }

  protected applyToolCenterChange(): void {
    const viewportsInfo = this.getViewportsInfo();
    // make sure center is within any volume

    viewportsInfo.forEach((enabledElement) => {
      const camera = enabledElement.viewport.getCamera();
      const { viewPlaneNormal, position, focalPoint } = camera;
      if (
        viewPlaneNormal !== undefined &&
        position !== undefined &&
        focalPoint !== undefined
      ) {
        const x1 = vec3.subtract(vec3.create(), this.toolCenter, focalPoint);
        let scalar = vec3.dot(x1, viewPlaneNormal);
        scalar /= vec3.length(viewPlaneNormal);
        let newPosition = vec3.add(
          vec3.create(),
          position,
          vec3.scale(vec3.create(), viewPlaneNormal, scalar)
        );
        let newFocalPoint = vec3.add(
          vec3.create(),
          focalPoint,
          vec3.scale(vec3.create(), viewPlaneNormal, scalar)
        );

        if (this.configuration.autoPan.enabled) {
          let pan = this.configuration.autoPan.panSize;
          if (!isFinite(pan)) {
            pan = 10;
          }
          const { clientWidth, clientHeight } = enabledElement.viewport.canvas;
          const toolCenterCanvas = enabledElement.viewport.worldToCanvas(
            this.toolCenter
          );

          const visiblePointCanvas = <Types.Point2>[
            toolCenterCanvas[0],
            toolCenterCanvas[1],
          ];
          if (toolCenterCanvas[0] < pan) {
            visiblePointCanvas[0] = pan;
          } else if (toolCenterCanvas[0] > clientWidth - pan) {
            visiblePointCanvas[0] = clientWidth - pan;
          }
          if (toolCenterCanvas[1] < pan) {
            visiblePointCanvas[1] = pan;
          } else if (toolCenterCanvas[1] > clientHeight - pan) {
            visiblePointCanvas[1] = clientHeight - pan;
          }
          if (
            visiblePointCanvas[0] !== toolCenterCanvas[0] ||
            visiblePointCanvas[1] !== toolCenterCanvas[1]
          ) {
            const visiblePointWorld =
              enabledElement.viewport.canvasToWorld(visiblePointCanvas);
            const deltaPointsWorld: vec3 = [
              visiblePointWorld[0] - this.toolCenter[0],
              visiblePointWorld[1] - this.toolCenter[1],
              visiblePointWorld[2] - this.toolCenter[2],
            ];
            newPosition = vec3.subtract(
              vec3.create(),
              newPosition,
              deltaPointsWorld
            );
            newFocalPoint = vec3.subtract(
              vec3.create(),
              newFocalPoint,
              deltaPointsWorld
            );
          }
        }
        const m = (a, b, n): boolean => {
          const d = a[n] - b[n];
          return d < 1e-3 && d > -1e-3;
        };
        if (
          m(position, newPosition, 0) ||
          m(position, newPosition, 1) ||
          m(position, newPosition, 2) ||
          m(focalPoint, newFocalPoint, 0) ||
          m(focalPoint, newFocalPoint, 1) ||
          m(focalPoint, newFocalPoint, 2)
        ) {
          enabledElement.viewport.setCamera({
            position: [newPosition[0], newPosition[1], newPosition[2]],
            focalPoint: [newFocalPoint[0], newFocalPoint[1], newFocalPoint[2]],
          });
          enabledElement.viewport.render();
        }
      }
    });
  }

  /**
   * addNewAnnotation acts as jump for the crosshairs tool. It is called when
   * the user clicks on the image. It does not store the annotation in the stateManager though.
   *
   * @param evt - The mouse event
   * @param interactionType - The type of interaction (e.g., mouse, touch, etc.)
   * @returns Crosshairs annotation
   */
  addNewAnnotation = (
    evt: ToolTypes.EventTypes.InteractionEventType
  ): CrosshairsAnnotation => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    const { currentPoints } = eventDetail;
    const enabledElement = getEnabledElement(element);
    if (enabledElement === undefined) {
      throw new Error('No enabledElement found for the given element');
    }

    const { viewport } = enabledElement;
    const annotations = this._getAnnotations(enabledElement);
    const filteredAnnotations = <CrosshairsAnnotation>(
      this.filterInteractableAnnotationsForElement(
        viewport.element,
        annotations
      )
    );

    // viewport Annotation
    const { data } = filteredAnnotations[0];
    const rotationPoints: RotPoints[] = data.handles.rotationPoints;
    for (let i = 0; i < rotationPoints.length - 1; i += 2) {
      const otherViewportId = rotationPoints[i].viewportId;
      if (this._getReferenceLineDraggable(otherViewportId)) {
        evt.preventDefault();
        data.activeViewportIds = [];
        data.handles.activeOperation = OPERATION.DRAG_CENTER;
        ToolCursors.elementCursor.hideElementCursor(element);
        this.setToolCenter(
          currentPoints.world,
          <Types.IVolumeViewport>viewport
        );
        this._activateModify(element);
        break;
      }
    }
    return filteredAnnotations[0];
  };

  cancel = () => {
    console.log('Not implemented yet');
  };

  /**
   * It checks if the mouse click is near crosshairs handles, if yes
   * it returns the handle location. If the mouse click is not near any
   * of the handles, it does not return anything.
   *
   * @param element - The element that the tool is attached to.
   * @param annotation - The annotation object associated with the annotation
   * @param canvasCoords - The coordinates of the mouse click on canvas
   * @param proximity - The distance from the mouse cursor to the point
   * that is considered "near".
   * @returns The handle that is closest to the cursor, or null if the cursor
   * is not near any of the handles.
   */
  getHandleNearImagePoint(
    element: HTMLDivElement,
    annotation: ToolTypes.Annotation,
    canvasCoords: Types.Point2,
    proximity: number
  ): ToolTypes.ToolHandle | undefined {
    const enabledElement = getEnabledElement(element);
    if (enabledElement === undefined) {
      throw new Error('No enabledElement found for the given element');
    }
    const { viewport } = enabledElement;

    let point = this._getRotationHandleNearImagePoint(
      viewport,
      annotation,
      canvasCoords,
      proximity
    );

    if (point !== null) {
      return point;
    }

    point = this._getSlabThicknessHandleNearImagePoint(
      viewport,
      annotation,
      canvasCoords,
      proximity
    );

    if (point !== null) {
      return point;
    }
    return undefined;
  }

  handleSelectedCallback = (
    evt: ToolTypes.EventTypes.InteractionEventType,
    annotation: ToolTypes.Annotation
  ): void => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    annotation.highlighted = true;

    // NOTE: handle index or coordinates are not used when dragging.
    // This because the handle points are actually generated in the renderTool and they are a derivative
    // from the camera variables of the viewports and of the slab thickness variable.
    // Remember that the translation and rotation operations operate on the camera
    // variables and not really on the handles. Similar for the slab thickness.
    this._activateModify(element);

    ToolCursors.elementCursor.hideElementCursor(element);

    evt.preventDefault();
  };

  /**
   * It returns if the canvas point is near the provided crosshairs annotation in the
   * provided element or not. A proximity is passed to the function to determine the
   * proximity of the point to the annotation in number of pixels.
   *
   * @param element - HTML Element
   * @param annotation - Annotation
   * @param canvasCoords - Canvas coordinates
   * @param proximity - Proximity to tool to consider
   * @returns Boolean, whether the canvas point is near tool
   */
  isPointNearTool = (
    element: HTMLDivElement,
    annotation: CrosshairsAnnotation,
    canvasCoords: Types.Point2,
    _proximity: number
  ): boolean => {
    if (this._pointNearTool(element, annotation, canvasCoords, 6)) {
      return true;
    }

    return false;
  };

  toolSelectedCallback = (
    evt: ToolTypes.EventTypes.InteractionEventType,
    annotation: ToolTypes.Annotation,
    _interactionType: ToolTypes.InteractionTypes
  ): void => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    annotation.highlighted = true;
    this._activateModify(element);

    ToolCursors.elementCursor.hideElementCursor(element);

    evt.preventDefault();
  };

  onCameraModified = (evt) => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    const enabledElement = getEnabledElement(element);
    if (enabledElement !== undefined) {
      const viewportInfos = this.getViewportsInfo();
      if (
        viewportInfos.find(
          ({ viewportId }) => viewportId === enabledElement.viewport.id
        ) !== undefined
      ) {
        const camera = enabledElement.viewport.getCamera();
        if (
          camera.viewPlaneNormal !== undefined &&
          camera.focalPoint !== undefined
        ) {
          const x1 = vec3.subtract(
            vec3.create(),
            camera.focalPoint,
            this.toolCenter
          );
          const scalar = vec3.dot(x1, camera.viewPlaneNormal);
          // scalar /= vec3.squaredLength(camera.viewPlaneNormal);
          if (scalar > 1e-3 || scalar < -1e-3) {
            const center = vec3.add(
              vec3.create(),
              this.toolCenter,
              vec3.scale(x1, camera.viewPlaneNormal, scalar)
            );
            this.setToolCenter(
              [center[0], center[1], center[2]],
              <Types.IVolumeViewport>enabledElement.viewport
            );
          }
        }
      }
    }
  };

  onResetCamera = (_evt) => {
    this.resetCrosshairs();
  };

  mouseMoveCallback = (
    evt: ToolTypes.EventTypes.MouseMoveEventType,
    filteredToolAnnotations: ToolTypes.Annotations | undefined
  ): boolean => {
    const { element, currentPoints } = evt.detail;
    const canvasCoords = currentPoints.canvas;
    let imageNeedsUpdate = false;
    if (filteredToolAnnotations === undefined) {
      return false;
    }

    for (let i = 0; i < filteredToolAnnotations.length; i++) {
      const annotation = filteredToolAnnotations[i] as CrosshairsAnnotation;

      if (
        ToolAnnotation.locking.isAnnotationLocked(annotation.annotationUID!)
      ) {
        continue;
      }

      const { data, highlighted } = annotation;
      if (!data.handles) {
        continue;
      }

      const previousActiveOperation = data.handles.activeOperation;
      const previousActiveViewportIds =
        data.activeViewportIds && data.activeViewportIds.length > 0
          ? [...data.activeViewportIds]
          : [];

      // This init are necessary, because when we move the mouse they are not cleaned by _endCallback
      data.activeViewportIds = [];
      data.handles.activeOperation = null;

      const handleNearImagePoint = this.getHandleNearImagePoint(
        element,
        annotation,
        canvasCoords,
        6
      );
      let near = false;
      if (handleNearImagePoint) {
        near = true;
      } else {
        near = this._pointNearTool(element, annotation, canvasCoords, 6);
      }
      if (near !== highlighted) {
        annotation.highlighted = near;
        imageNeedsUpdate = true;
      } else if (
        data.handles.activeOperation !== previousActiveOperation ||
        !this._areViewportIdArraysEqual(
          data.activeViewportIds,
          previousActiveViewportIds
        )
      ) {
        imageNeedsUpdate = true;
      }
    }

    return imageNeedsUpdate;
  };

  filterInteractableAnnotationsForElement = (element, annotations) => {
    if (!annotations || !annotations.length) {
      return [];
    }

    const enabledElement = getEnabledElement(element);
    if (enabledElement === undefined) {
      throw new Error('No enabledElement found for the given element');
    }
    const { viewportId } = enabledElement;

    const viewportUIDSpecificCrosshairs = annotations.filter(
      (annotation) => annotation.data.viewportId === viewportId
    );

    return viewportUIDSpecificCrosshairs;
  };

  /**
   * renders the crosshairs lines and handles in the requestAnimationFrame callback
   *
   * @param enabledElement - The Cornerstone's enabledElement.
   * @param svgDrawingHelper - The svgDrawingHelper providing the context for drawing.
   */
  renderAnnotation = (
    enabledElement: Types.IEnabledElement,
    svgDrawingHelper: ToolTypes.SVGDrawingHelper
  ): boolean => {
    const { viewport } = enabledElement;
    const { element } = viewport;
    const annotations = this._getAnnotations(enabledElement);
    const camera = viewport.getCamera();
    if (camera.viewPlaneNormal === undefined) {
      throw new Error('invalid camera');
    }
    const filteredToolAnnotations =
      this.filterInteractableAnnotationsForElement(element, annotations);

    // viewport Annotation
    const viewportAnnotation = filteredToolAnnotations[0];
    if (!annotations?.length || !viewportAnnotation?.data) {
      // No annotations yet, and didn't just create it as we likely don't have a FrameOfReference/any data loaded yet.
      return false;
    }

    const annotationUID = viewportAnnotation.annotationUID;

    const planeNormal = camera.viewPlaneNormal;
    const { clientWidth, clientHeight } = viewport.canvas;
    // get canvas information for points and lines (canvas box, canvas horizontal distances)

    const canvasBox = [0, 0, clientWidth, clientHeight];
    const canvasMinDimensionLength = Math.min(clientWidth, clientHeight);
    const canvasDimensionLength = clientWidth + clientHeight; // could diagonal length
    const centerGap = Math.min(
      this.configuration.referenceLinesCenterGapRadius,
      canvasMinDimensionLength * 0.1
    ); // make sure it is less than "short = 0.2"
    // Graphic:
    // Mid -> SlabThickness handle
    // Short -> Rotation handle
    //                           Long
    //                            |
    //                            |
    //                            |
    //                           Mid
    //                            |
    //                            |
    //                            |
    //                          Short
    //                            |
    //                            |
    //                            |
    // Long --- Mid--- Short--- Center --- Short --- Mid --- Long
    //                            |
    //                            |
    //                            |
    //                          Short
    //                            |
    //                            |
    //                            |
    //                           Mid
    //                            |
    //                            |
    //                            |
    //                           Long

    const center2d = viewport.worldToCanvas(this.toolCenter);
    const rotationPoints: RotPoints[] = []; // rotation handles, used for rotation interactions
    const slabThicknessPoints: RotPoints[] = []; // slab thickness handles, used for setting the slab thickness

    this.getViewportsInfo().forEach((otherviewport) => {
      if (otherviewport.viewportId === enabledElement.viewportId) {
        return;
      }
      const otherNormal = otherviewport.viewport.getCamera().viewPlaneNormal;
      if (otherNormal === undefined) {
        return;
      }
      const direction = vec3.create();
      vec3.cross(direction, planeNormal, otherNormal);
      if (vec3.length(direction) > 1e-3) {
        vec3.normalize(direction, direction);
        // convert 3D to 2D
        const p1_3d: Types.Point3 = [0, 0, 0];
        vec3.add(p1_3d, this.toolCenter, direction);
        const p1_2d = viewport.worldToCanvas(p1_3d);
        const direction2d: vec2 = [
          p1_2d[0] - center2d[0],
          p1_2d[1] - center2d[1],
        ];
        vec2.normalize(direction2d, direction2d);

        const addScale = (scale: number): Types.Point2 => {
          return [
            center2d[0] + scale * direction2d[0],
            center2d[1] + scale * direction2d[1],
          ];
        };
        const slabThicknessValue = (<Types.IVolumeViewport>(
          otherviewport.viewport
        )).getSlabThickness();
        const shiftSlab = (pt: vec2, up: boolean): Types.Point2 => {
          const pt3 = viewport.canvasToWorld([pt[0], pt[1]]);
          if (up) {
            vec3.add(
              pt3,
              pt3,
              vec3.scale(vec3.create(), otherNormal, slabThicknessValue)
            );
          } else {
            vec3.add(
              pt3,
              pt3,
              vec3.scale(vec3.create(), otherNormal, -slabThicknessValue)
            );
          }
          return viewport.worldToCanvas(pt3);
        };

        const liangBarksyClip = (
          pt1: Types.Point2,
          pt2: Types.Point2,
          box
        ): boolean =>
          0 !== ToolUtilities.math.vec2.liangBarksyClip(pt1, pt2, box);

        const long1 = addScale(canvasDimensionLength);
        const center1 = addScale(centerGap);
        const ls1u = shiftSlab(long1, true);
        const ls1d = shiftSlab(long1, false);
        const long2 = addScale(-canvasDimensionLength);
        const center2 = addScale(-centerGap);
        const ls2u = shiftSlab(long2, true);
        const ls2d = shiftSlab(long2, false);
        const mid1 = addScale(canvasMinDimensionLength * 0.4);
        const short1 = addScale(canvasMinDimensionLength * 0.2);
        const s1u = shiftSlab(short1, true);
        const s1d = shiftSlab(short1, false);
        const mid2 = addScale(-canvasMinDimensionLength * 0.4);
        const short2 = addScale(-canvasMinDimensionLength * 0.2);
        const s2u = shiftSlab(short2, true);
        const s2d = shiftSlab(short2, false);

        const color = this._getReferenceLineColor(otherviewport.viewportId);
        const selectedViewportId =
          viewportAnnotation.data.activeViewportIds.find(
            (id) => id === otherviewport.viewportId
          );
        const lineWidth =
          selectedViewportId &&
          viewportAnnotation.data.handles.activeOperation ===
            OPERATION.DRAG_LINE
            ? 2
            : 1;

        const drawL1 = liangBarksyClip(long1, center1, canvasBox);
        if (drawL1) {
          drawSvg.drawLine(
            svgDrawingHelper,
            annotationUID,
            `line1-${otherviewport.viewportId}`,
            long1,
            center1,
            {
              color,
              lineWidth,
              lineDash: undefined,
            }
          );
        }
        const drawL2 = liangBarksyClip(long2, center2, canvasBox);
        if (drawL2) {
          drawSvg.drawLine(
            svgDrawingHelper,
            annotationUID,
            `line2-${otherviewport.viewportId}`,
            long2,
            center2,
            {
              color,
              lineWidth,
              lineDash: undefined,
            }
          );
        }

        if (slabThicknessValue >= 0.5) {
          const drawU = liangBarksyClip(ls1u, ls2u, canvasBox);
          if (drawU) {
            drawSvg.drawLine(
              svgDrawingHelper,
              annotationUID,
              `lnSU-${otherviewport.viewportId}`,
              ls1u,
              ls2u,
              {
                color,
                lineWidth,
                lineDash: [2, 3],
              }
            );
            const drawD = liangBarksyClip(ls1d, ls2d, canvasBox);
            if (drawD) {
              drawSvg.drawLine(
                svgDrawingHelper,
                annotationUID,
                `lnSD-${otherviewport.viewportId}`,
                ls1d,
                ls2d,
                {
                  color,
                  lineWidth,
                  lineDash: [2, 3],
                }
              );
            }
          }
        }
        rotationPoints.push(
          {
            world: viewport.canvasToWorld(mid1),
            viewportId: otherviewport.viewportId,
            pt1: long1,
            pt2: long2,
          },
          {
            world: viewport.canvasToWorld(mid2),
            viewportId: otherviewport.viewportId,
            pt1: long1,
            pt2: long2,
          }
        );
        slabThicknessPoints.push(
          {
            world: viewport.canvasToWorld(s1d),
            viewportId: otherviewport.viewportId,
            pt1: ls1d,
            pt2: ls2d,
          },
          {
            world: viewport.canvasToWorld(s2d),
            viewportId: otherviewport.viewportId,
            pt1: ls1d,
            pt2: ls2d,
          },
          {
            world: viewport.canvasToWorld(s1u),
            viewportId: otherviewport.viewportId,
            pt1: ls1u,
            pt2: ls2u,
          },
          {
            world: viewport.canvasToWorld(s2u),
            viewportId: otherviewport.viewportId,
            pt1: ls1u,
            pt2: ls2u,
          }
        );
        let handleRadius = this.configuration.handleRadius;
        if (this.configuration.enableHDPIHandles === true) {
          handleRadius *= window.devicePixelRatio;
        }
        let opacity = 1;
        if (this.configuration.mobile?.enabled) {
          handleRadius = this.configuration.mobile.handleRadius;
          opacity = this.configuration.mobile.opacity;
        }
        if (
          this._getReferenceLineRotatable(otherviewport.viewportId) &&
          selectedViewportId &&
          viewportAnnotation.data.handles.activeOperation !== OPERATION.SLAB
        ) {
          drawSvg.drawHandles(
            svgDrawingHelper,
            annotationUID,
            `rotation-${otherviewport.viewportId}`,
            [mid1, mid2],
            {
              color,
              handleRadius,
              opacity,
              type: 'circle',
            }
          );
        }
        if (
          this._getReferenceLineSlabThicknessControlsOn(
            otherviewport.viewportId
          ) &&
          selectedViewportId &&
          viewportAnnotation.data.handles.activeOperation !== OPERATION.ROTATE
        ) {
          drawSvg.drawHandles(
            svgDrawingHelper,
            annotationUID,
            `slab-${otherviewport.viewportId}`,
            [s1d, s2d, s1u, s2u],
            {
              color,
              handleRadius,
              opacity,
              type: 'rect',
            }
          );
        }
      }
    });
    // Save new handles points in annotation
    viewportAnnotation.data.handles.rotationPoints = rotationPoints;
    viewportAnnotation.data.handles.slabThicknessPoints = slabThicknessPoints;

    if (this.configuration.viewportIndicators) {
      const { viewportIndicatorsConfig } = this.configuration;

      const xOffset = viewportIndicatorsConfig?.xOffset || 0.95;
      const yOffset = viewportIndicatorsConfig?.yOffset || 0.05;
      const referenceColorCoordinates = [
        clientWidth * xOffset,
        clientHeight * yOffset,
      ];

      const circleRadius =
        viewportIndicatorsConfig?.circleRadius ||
        Math.max(1, canvasMinDimensionLength * 0.01);

      const circleUID = '0';
      const color = this._getReferenceLineColor(viewport.id);
      drawSvg.drawCircle(
        svgDrawingHelper,
        annotationUID,
        circleUID,
        referenceColorCoordinates as Types.Point2,
        circleRadius,
        { color, fill: color }
      );
    }

    return true;
  };

  _getAnnotations = (
    enabledElement: Types.IEnabledElement
  ): CrosshairsAnnotation[] => {
    const { viewport } = enabledElement;
    const annotations =
      ToolAnnotation.state.getAnnotations(
        this.getToolName(),
        viewport.element
      ) || [];
    const viewportIds = this.getViewportsInfo().map(
      ({ viewportId }) => viewportId
    );

    // filter the annotations to only keep that are for this toolGroup
    const toolGroupAnnotations = annotations.filter((annotation) => {
      const { data } = annotation;
      return viewportIds.includes(<string>data.viewportId);
    });

    return <CrosshairsAnnotation[]>toolGroupAnnotations;
  };

  protected onNewVolume(): void {
    this.initToolCenter();
  }

  protected initToolCenter(): void {
    const viewportsInfo = this.getViewportsInfo();
    if (viewportsInfo.length > 0) {
      const image = <Types.IImageData>(
        (<Types.IViewport>viewportsInfo[0].viewport).getImageData()
      );
      const dims = image.imageData.getDimensions();
      // init center to the center of the volume
      const center = image.imageData.indexToWorld([
        dims[0] / 2,
        dims[1] / 2,
        dims[2] / 2,
      ]);
      viewportsInfo.forEach((enabledElement) => {
        // project current center onto each view plane
        const camera = enabledElement.viewport.getCamera();
        if (
          camera.viewPlaneNormal !== undefined &&
          camera.focalPoint !== undefined
        ) {
          const x1 = vec3.subtract(vec3.create(), center, camera.focalPoint);
          const scalar = vec3.dot(x1, camera.viewPlaneNormal);
          vec3.add(center, center, vec3.scale(x1, x1, scalar));
        }
      });
      this.setToolCenter([center[0], center[1], center[2]]);
      viewportsInfo.forEach((enabledElement) =>
        this.initializeViewport(enabledElement)
      );
    }
  }

  _unsubscribeToViewportNewVolumeSet(viewportsInfo: Types.IEnabledElement[]) {
    viewportsInfo.forEach(({ viewport }) => {
      viewport.element.removeEventListener(
        Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
        this.onNewVolume
      );
    });
  }

  _subscribeToViewportNewVolumeSet(viewports: Types.IEnabledElement[]) {
    viewports.forEach(({ viewport }) => {
      viewport.element.addEventListener(
        Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME,
        this.onNewVolume
      );
    });
  }

  _areViewportIdArraysEqual = (viewportIdArrayOne, viewportIdArrayTwo) => {
    if (viewportIdArrayOne.length !== viewportIdArrayTwo.length) {
      return false;
    }

    viewportIdArrayOne.forEach((id) => {
      for (let i = 0; i < viewportIdArrayTwo.length; ++i) {
        if (id === viewportIdArrayTwo[i]) {
          return true;
        }
      }
      return false;
    });

    return true;
  };

  _activateModify = (element) => {
    // mobile sometimes has lingering interaction even when touchEnd triggers
    // this check allows for multiple handles to be active which doesn't affect
    // tool usage.
    state.isInteractingWithTool = !this.configuration.mobile?.enabled;

    element.addEventListener(ToolEnums.Events.MOUSE_UP, this._endCallback);
    element.addEventListener(ToolEnums.Events.MOUSE_DRAG, this._dragCallback);
    element.addEventListener(ToolEnums.Events.MOUSE_CLICK, this._endCallback);

    element.addEventListener(ToolEnums.Events.TOUCH_END, this._endCallback);
    element.addEventListener(ToolEnums.Events.TOUCH_DRAG, this._dragCallback);
    element.addEventListener(ToolEnums.Events.TOUCH_TAP, this._endCallback);
  };

  _deactivateModify = (element) => {
    state.isInteractingWithTool = false;

    element.removeEventListener(ToolEnums.Events.MOUSE_UP, this._endCallback);
    element.removeEventListener(
      ToolEnums.Events.MOUSE_DRAG,
      this._dragCallback
    );
    element.removeEventListener(
      ToolEnums.Events.MOUSE_CLICK,
      this._endCallback
    );

    element.removeEventListener(ToolEnums.Events.TOUCH_END, this._endCallback);
    element.removeEventListener(
      ToolEnums.Events.TOUCH_DRAG,
      this._dragCallback
    );
    element.removeEventListener(ToolEnums.Events.TOUCH_TAP, this._endCallback);
  };

  _endCallback = (evt: ToolTypes.EventTypes.InteractionEventType) => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;

    this.editData!.annotation.data.handles!.activeOperation = null;
    this.editData!.annotation.data.activeViewportIds = [];

    this._deactivateModify(element);

    ToolCursors.elementCursor.resetElementCursor(element);

    this.editData = null;

    const requireSameOrientation = false;
    const viewportIdsToRender =
      ToolUtilities.viewportFilters.getViewportIdsWithToolToRender(
        element,
        this.getToolName(),
        requireSameOrientation
      );

    ToolUtilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  };

  _dragCallback = (evt: ToolTypes.EventTypes.InteractionEventType) => {
    const eventDetail = evt.detail;

    const delta = eventDetail.deltaPoints.world;

    if (
      Math.abs(delta[0]) < 1e-3 &&
      Math.abs(delta[1]) < 1e-3 &&
      Math.abs(delta[2]) < 1e-3
    ) {
      return;
    }

    const { element } = eventDetail;
    const enabledElement = getEnabledElement(element);
    if (enabledElement === undefined) {
      throw new Error('No enabled element found');
    }
    const { viewport } = enabledElement;
    const annotations = this._getAnnotations(enabledElement).filter(
      (a) => a.data.viewportId === enabledElement.viewport.id
    );
    if (annotations.length < 1) {
      throw new Error('Invalid number of annotations');
    }
    const viewportAnnotation = annotations[0];
    const { handles } = viewportAnnotation.data;

    if (handles.activeOperation === OPERATION.DRAG_LINE) {
      // TRANSLATION
      if (viewportAnnotation.data.activeViewportIds.length < 1) {
        throw new Error('Invalid number of active viewports');
      }
      const rotation = handles.rotationPoints.find(
        (r: RotPoints) =>
          r.viewportId === viewportAnnotation.data.activeViewportIds[0]
      );
      if (rotation === undefined) {
        throw new Error('No rotation handle found');
      }
      const direction: vec2 = vec2.normalize(vec2.create(), [
        rotation.pt1[1] - rotation.pt2[1],
        rotation.pt2[0] - rotation.pt1[0],
      ]);
      const center = enabledElement.viewport.worldToCanvas(this.toolCenter);
      const scale = vec2.dot(direction, [
        eventDetail.currentPoints.canvas[0] - center[0],
        eventDetail.currentPoints.canvas[1] - center[1],
      ]);
      this.setToolCenter(
        enabledElement.viewport.canvasToWorld([
          center[0] + direction[0] * scale,
          center[1] + direction[1] * scale,
        ]),
        <Types.IVolumeViewport>enabledElement.viewport
      );
      return;
    } else if (handles.activeOperation === OPERATION.DRAG_CENTER) {
      this.setToolCenter(
        eventDetail.currentPoints.world,
        <Types.IVolumeViewport>enabledElement.viewport
      );
      return;
    } else if (handles.activeOperation === OPERATION.ROTATE) {
      // ROTATION
      if (viewportAnnotation.data.activeViewportIds.length < 1) {
        throw new Error('Invalid number of active viewports');
      }
      const otherViewportInfo = this.getViewportsInfo().find(
        (v) => v.viewportId === viewportAnnotation.data.activeViewportIds[0]
      );
      if (otherViewportInfo === undefined) {
        throw new Error('No other viewport found');
      }
      const centerCanvas = viewport.worldToCanvas(this.toolCenter);
      const finalPointCanvas = eventDetail.currentPoints.canvas;
      const originalPointCanvas = eventDetail.lastPoints.canvas;
      const dir1 = vec2.create();
      const dir2 = vec2.create();
      vec2.sub(dir1, originalPointCanvas, <vec2>centerCanvas);
      vec2.sub(dir2, finalPointCanvas, <vec2>centerCanvas);
      let angle = vec2.angle(dir1, dir2);
      if (
        this._isClockWise(centerCanvas, originalPointCanvas, finalPointCanvas)
      ) {
        angle *= -1;
      }

      // Rounding the angle to allow rotated handles to be undone
      // If we don't round and rotate handles clockwise by 0.0131233 radians,
      // there's no assurance that the counter-clockwise rotation occurs at
      // precisely -0.0131233, resulting in the drawn annotations being lost.
      angle = Math.round(angle * 100) / 100;

      const rotationAxis = viewport.getCamera().viewPlaneNormal;
      // @ts-ignore : vtkjs incorrect typing
      const { matrix } = vtkMatrixBuilder
        .buildFromRadian()
        .translate(this.toolCenter[0], this.toolCenter[1], this.toolCenter[2])
        .rotate(angle, rotationAxis!)
        .translate(
          -this.toolCenter[0],
          -this.toolCenter[1],
          -this.toolCenter[2]
        );

      const viewportsToUpdate = [otherViewportInfo];
      if (this.configuration.forceOrthogonal === true) {
        this.getViewportsInfo().forEach((v) => {
          if (
            undefined ===
            viewportsToUpdate.find((vv) => v.viewportId === vv.viewportId)
          ) {
            const s1 = vec3.dot(
              v.viewport.getCamera().viewPlaneNormal!,
              viewport.getCamera().viewPlaneNormal!
            );
            if (s1 > -1e-3 && s1 < 1e-3) {
              viewportsToUpdate.push(v);
            }
          }
        });
      }

      viewportsToUpdate.forEach((v) => {
        const camera = v.viewport.getCamera();
        const { viewUp, position, focalPoint } = camera;
        if (
          focalPoint === undefined ||
          position === undefined ||
          viewUp === undefined
        ) {
          throw new Error('invalid camera');
        }
        vec3.transformMat4(focalPoint, focalPoint, matrix);
        vec3.transformMat4(position, position, matrix);
        vec3.add(viewUp, viewUp, this.toolCenter);
        vec3.transformMat4(viewUp, viewUp, matrix);
        vec3.subtract(viewUp, viewUp, this.toolCenter);

        v.viewport.setCamera({
          position,
          viewUp,
          focalPoint,
        });
        v.viewport.render();
      });
      enabledElement.viewport.render();
      return;
    } else if (handles.activeOperation === OPERATION.SLAB) {
      if (viewportAnnotation.data.activeViewportIds.length < 1) {
        throw new Error('Invalid number of active viewports');
      }
      const otherViewportInfo = this.getViewportsInfo().find(
        (v) => v.viewportId === viewportAnnotation.data.activeViewportIds[0]
      );
      if (otherViewportInfo === undefined) {
        throw new Error('No other viewport found');
      }
      const x = vec3.subtract(
        vec3.create(),
        this.toolCenter,
        eventDetail.currentPoints.world
      );
      let slabThickness = Math.abs(
        vec3.dot(x, otherViewportInfo.viewport.getCamera().viewPlaneNormal!) /
          vec3.length(otherViewportInfo.viewport.getCamera().viewPlaneNormal!)
      );
      if (slabThickness < 0.5) {
        slabThickness = RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS;
      }
      this.setSlabThickness(otherViewportInfo.viewport, slabThickness);
      otherViewportInfo.viewport.render();
      viewport.render();
      return;
    }
  };

  setSlabThickness(viewport, slabThickness) {
    let actorUIDs;
    const { filterActorUIDsToSetSlabThickness } = this.configuration;
    if (
      filterActorUIDsToSetSlabThickness &&
      filterActorUIDsToSetSlabThickness.length > 0
    ) {
      actorUIDs = filterActorUIDsToSetSlabThickness;
    }

    let blendModeToUse = this.configuration.slabThicknessBlendMode;
    if (slabThickness === RENDERING_DEFAULTS.MINIMUM_SLAB_THICKNESS) {
      blendModeToUse = Enums.BlendModes.COMPOSITE;
    }

    const immediate = false;
    viewport.setBlendMode(blendModeToUse, actorUIDs, immediate);
    viewport.setSlabThickness(slabThickness, actorUIDs);
  }

  _isClockWise(a, b, c) {
    // return true if the rotation is clockwise
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
  }

  _getRotationHandleNearImagePoint(
    viewport,
    annotation,
    canvasCoords,
    proximity
  ) {
    const { data } = annotation;
    const rotationPoints: RotPoints[] = data.handles.rotationPoints;

    for (let i = 0; i < rotationPoints.length; i++) {
      const point = rotationPoints[i].world;
      const otherViewportId = rotationPoints[i].viewportId;
      const viewportDraggableRotatable =
        this._getReferenceLineDraggable(otherViewportId) ||
        this._getReferenceLineRotatable(otherViewportId);
      if (!viewportDraggableRotatable) {
        continue;
      }

      const annotationCanvasCoordinate = viewport.worldToCanvas(point);
      if (vec2.distance(canvasCoords, annotationCanvasCoordinate) < proximity) {
        data.handles.activeOperation = OPERATION.ROTATE;
        data.activeViewportIds = [otherViewportId];

        this.editData = {
          annotation,
        };

        return point;
      }
    }

    return null;
  }

  _getSlabThicknessHandleNearImagePoint(
    viewport,
    annotation,
    canvasCoords,
    proximity
  ) {
    const { data } = annotation;
    const slabThicknessPoints: RotPoints[] = data.handles.slabThicknessPoints;

    for (let i = 0; i < slabThicknessPoints.length; i++) {
      const point = slabThicknessPoints[i].world;
      const otherViewportId = slabThicknessPoints[i].viewportId;
      const viewportSlabThicknessControlsOn =
        this._getReferenceLineSlabThicknessControlsOn(otherViewportId);
      if (!viewportSlabThicknessControlsOn) {
        continue;
      }
      const annotationCanvasCoordinate = viewport.worldToCanvas(point);
      if (vec2.distance(canvasCoords, annotationCanvasCoordinate) < proximity) {
        data.handles.activeOperation = OPERATION.SLAB;
        data.activeViewportIds = [otherViewportId];
        this.editData = {
          annotation,
        };
        return point;
      }
    }
    return null;
  }

  _pointNearTool(element, annotation, canvasCoords, proximity): boolean {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement!;
    const { clientWidth, clientHeight } = viewport.canvas;
    const canvasDiagonalLength = Math.sqrt(
      clientWidth * clientWidth + clientHeight * clientHeight
    );
    const { data } = annotation;

    const rotationPoints: RotPoints[] = data.handles.rotationPoints;
    const slabThicknessPoints: RotPoints[] = data.handles.slabThicknessPoints;
    const viewportIdArray: string[] = [];

    if (
      vec2.distance(canvasCoords, viewport.worldToCanvas(this.toolCenter)) <
      proximity
    ) {
      // drag center if any axis is enabled
      if (
        this.getViewportsInfo().find((v) => {
          if (v.viewportId !== viewport.id) {
            const draggable = this._getReferenceLineDraggable(v.viewportId);
            if (draggable) {
              // ignore if the planes are parallel
              const notSamePlane = vec3.dot(
                v.viewport.getCamera().viewPlaneNormal!,
                viewport.getCamera().viewPlaneNormal!
              );
              if (notSamePlane > 1e-3 || notSamePlane < -1e-3) {
                return true;
              }
            }
          }
          return false;
        }) !== undefined
      ) {
        data.handles.activeOperation = OPERATION.DRAG_CENTER;
      }
    } else {
      for (let i = 0; i < rotationPoints.length - 1; i += 2) {
        const otherViewportId = rotationPoints[i].viewportId;
        const draggable = this._getReferenceLineDraggable(otherViewportId);
        if (draggable) {
          const distanceToPoint1 =
            ToolUtilities.math.lineSegment.distanceToPoint(
              rotationPoints[i].pt1,
              rotationPoints[i].pt2,
              [canvasCoords[0], canvasCoords[1]]
            );
          const distanceToPoint2 =
            ToolUtilities.math.lineSegment.distanceToPoint(
              rotationPoints[i + 1].pt1,
              rotationPoints[i + 1].pt2,
              [canvasCoords[0], canvasCoords[1]]
            );
          if (distanceToPoint1 <= proximity || distanceToPoint2 <= proximity) {
            viewportIdArray.push(otherViewportId);
            data.handles.activeOperation = OPERATION.DRAG_LINE;
          }
        }
      }

      for (let i = 0; i < slabThicknessPoints.length - 1; i += 2) {
        const otherViewportId = slabThicknessPoints[i].viewportId;
        if (viewportIdArray.find((id) => id === otherViewportId)) {
          continue;
        }
        const viewportSlabThicknessControlsOn =
          this._getReferenceLineSlabThicknessControlsOn(otherViewportId);
        const viewportRotatable =
          this._getReferenceLineRotatable(otherViewportId);
        if (viewportSlabThicknessControlsOn || viewportRotatable) {
          const stPointLineCanvas1 = slabThicknessPoints[i].pt1;
          const stPointLineCanvas2 = slabThicknessPoints[i].pt2;

          const centerCanvas = vec2.create();
          vec2.add(centerCanvas, stPointLineCanvas1, stPointLineCanvas2);
          vec2.scale(centerCanvas, centerCanvas, 0.5);

          const canvasUnitVectorFromCenter = vec2.create();
          vec2.subtract(
            canvasUnitVectorFromCenter,
            stPointLineCanvas1,
            centerCanvas
          );
          vec2.normalize(
            canvasUnitVectorFromCenter,
            canvasUnitVectorFromCenter
          );

          const canvasVectorFromCenterStart = vec2.create();
          vec2.scale(
            canvasVectorFromCenterStart,
            canvasUnitVectorFromCenter,
            canvasDiagonalLength * 0.05
          );

          const stPointLineCanvas1Start = vec2.create();
          const stPointLineCanvas2Start = vec2.create();
          vec2.add(
            stPointLineCanvas1Start,
            centerCanvas,
            canvasVectorFromCenterStart
          );
          vec2.subtract(
            stPointLineCanvas2Start,
            centerCanvas,
            canvasVectorFromCenterStart
          );

          const lineSegment1 = {
            start: {
              x: stPointLineCanvas1Start[0],
              y: stPointLineCanvas1Start[1],
            },
            end: {
              x: stPointLineCanvas1[0],
              y: stPointLineCanvas1[1],
            },
          };

          const distanceToPoint1 =
            ToolUtilities.math.lineSegment.distanceToPoint(
              [lineSegment1.start.x, lineSegment1.start.y],
              [lineSegment1.end.x, lineSegment1.end.y],
              [canvasCoords[0], canvasCoords[1]]
            );

          const lineSegment2 = {
            start: {
              x: stPointLineCanvas2Start[0],
              y: stPointLineCanvas2Start[1],
            },
            end: {
              x: stPointLineCanvas2[0],
              y: stPointLineCanvas2[1],
            },
          };
          const distanceToPoint2 =
            ToolUtilities.math.lineSegment.distanceToPoint(
              [lineSegment2.start.x, lineSegment2.start.y],
              [lineSegment2.end.x, lineSegment2.end.y],
              [canvasCoords[0], canvasCoords[1]]
            );

          if (distanceToPoint1 <= proximity || distanceToPoint2 <= proximity) {
            viewportIdArray.push(otherViewportId); // we still need this to draw inactive slab thickness handles
            data.handles.activeOperation = null; // no operation
          }
        }
      }
    }

    data.activeViewportIds = [...viewportIdArray];

    this.editData = {
      annotation,
    };

    return data.handles.activeOperation !== null ? true : false;
  }
}
