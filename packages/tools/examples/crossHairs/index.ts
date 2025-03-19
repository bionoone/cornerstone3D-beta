import type { Types } from '@cornerstonejs/core';
import {
  RenderingEngine,
  Enums,
  setVolumesForViewports,
  volumeLoader,
  getRenderingEngine,
} from '@cornerstonejs/core';
import {
  initDemo,
  createImageIdsAndCacheMetaData,
  setTitleAndDescription,
  setCtTransferFunctionForVolumeActor,
  addDropdownToToolbar,
  addManipulationBindings,
  getLocalUrl,
  addToggleButtonToToolbar,
  addButtonToToolbar,
} from '../../../../utils/demo/helpers';
import * as cornerstoneTools from '@cornerstonejs/tools';

// This is for debugging purposes
console.warn(
  'Click on index.ts to open source code for this example --------->'
);

const {
  ToolGroupManager,
  Enums: csToolsEnums,
  CrosshairsTool,
  synchronizers,
} = cornerstoneTools;

const { createSlabThicknessSynchronizer } = synchronizers;

const { MouseBindings } = csToolsEnums;
const { ViewportType } = Enums;

// Define a unique id for the volume
const volumeName = 'CT_VOLUME_ID'; // Id of the volume less loader prefix
const volumeLoaderScheme = 'cornerstoneStreamingImageVolume'; // Loader id which defines which volume loader to use
const volumeId = `${volumeLoaderScheme}:${volumeName}`; // VolumeId with loader id + volume id
const toolGroupId = 'MY_TOOLGROUP_ID';
const viewportId1 = 'CT_AXIAL';
const viewportId2 = 'CT_SAGITTAL';
const viewportId3 = 'CT_CORONAL';
const viewportId4 = 'CT_OTHER';
const viewportId5 = 'CT_OTHER2';

const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);
const paramValue = urlParams.get('viewports');

let nbViewports = 3;
try {
  nbViewports = Math.min(5, Math.max(2, parseInt(paramValue)));
} catch (e) {
  console.error('Invalid number of viewports');
  nbViewports = 3;
} finally {
  if (!isFinite(nbViewports)) {
    nbViewports = 3;
  }
}

const viewportIds = [
  viewportId1,
  viewportId2,
  viewportId3,
  viewportId4,
  viewportId5,
].slice(0, nbViewports);

const renderingEngineId = 'myRenderingEngine';
const synchronizerId = 'SLAB_THICKNESS_SYNCHRONIZER_ID';

// ======== Set up page ======== //
setTitleAndDescription(
  'Crosshairs',
  'Here we demonstrate crosshairs linking several views of the same data. You can select the blend mode that will be used if you modify the slab thickness of the crosshairs by dragging the control points.'
);

const size = '500px';
const content = document.getElementById('content');
const viewportGrid = document.createElement('div');

viewportGrid.style.display = 'flex';
viewportGrid.style.display = 'flex';
viewportGrid.style.flexDirection = 'row';

const make = (): HTMLDivElement => {
  const element1 = document.createElement('div');
  element1.style.width = size;
  element1.style.height = size;
  // Disable right click context menu so we can have right click tools
  element1.oncontextmenu = (e) => e.preventDefault();
  viewportGrid.appendChild(element1);
  return element1;
};

const elements = viewportIds.map((id) => {
  return {
    id,
    element: make(),
  };
});

content.appendChild(viewportGrid);

const instructions = document.createElement('p');
instructions.innerHTML = `
  Basic controls:<br/>
  - Click/Drag anywhere in the viewport to move the center of the crosshairs.<br/>
  - Drag a reference line to move it, scrolling the other views.<br/>
<br/>
  Advanced controls: Hover over a line and find the following two handles:<br/>
  - Square (closest to center): Drag these to change the thickness of the MIP slab in that plane.<br/>
  - Circle (further from center): Drag these to rotate the axes.<br/>
  <br/>
  you can change number of viewport : <a href="?viewports=2">2</a> ,  <a href="?viewports=3">3</a>, <a href="?viewports=4">4</a> or <a href="?viewports=5">5</a> (or more)
  `;

content.append(instructions);

addButtonToToolbar({
  title: 'Reset Camera',
  onClick: () => {
    const viewport1 = getRenderingEngine(
      renderingEngineId
    ).getViewports()[0] as Types.IVolumeViewport;
    const resetPan = true;
    const resetZoom = true;
    const resetToCenter = true;
    const resetRotation = true;
    viewport1.resetCamera({
      resetPan,
      resetZoom,
      resetToCenter,
      resetRotation,
    });

    viewport1.render();
  },
});

// ============================= //

const viewportColors = {
  [viewportId1]: 'rgb(200, 0, 0)',
  [viewportId2]: 'rgb(200, 200, 0)',
  [viewportId3]: 'rgb(0, 200, 0)',
  [viewportId4]: 'rgb(0, 0, 200)',
  [viewportId5]: 'rgb(207, 106, 39)',
};

let synchronizer;

let OptionRotatable = true;
let OptionDraggable = true;
let OptionSlab = true;

function getReferenceLineColor(viewportId) {
  return viewportColors[viewportId];
}

function getReferenceLineDraggable(viewportId) {
  return OptionDraggable;
}

function getReferenceLineRotatable(viewportId) {
  return OptionRotatable;
}

function getReferenceLineSlabThicknessControlsOn(viewportId) {
  return OptionSlab;
}

const blendModeOptions = {
  MIP: 'Maximum Intensity Projection',
  MINIP: 'Minimum Intensity Projection',
  AIP: 'Average Intensity Projection',
};

addDropdownToToolbar({
  options: {
    values: [
      'Maximum Intensity Projection',
      'Minimum Intensity Projection',
      'Average Intensity Projection',
    ],
    defaultValue: 'Maximum Intensity Projection',
  },
  onSelectedValueChange: (selectedValue) => {
    let blendModeToUse;
    switch (selectedValue) {
      case blendModeOptions.MIP:
        blendModeToUse = Enums.BlendModes.MAXIMUM_INTENSITY_BLEND;
        break;
      case blendModeOptions.MINIP:
        blendModeToUse = Enums.BlendModes.MINIMUM_INTENSITY_BLEND;
        break;
      case blendModeOptions.AIP:
        blendModeToUse = Enums.BlendModes.AVERAGE_INTENSITY_BLEND;
        break;
      default:
        throw new Error('undefined orientation option');
    }

    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);

    const crosshairsInstance = toolGroup.getToolInstance(
      CrosshairsTool.toolName
    );
    const oldConfiguration = crosshairsInstance.configuration;

    crosshairsInstance.configuration = {
      ...oldConfiguration,
      slabThicknessBlendMode: blendModeToUse,
    };

    // Update the blendMode for actors to instantly reflect the change
    toolGroup.viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
      const renderingEngine = getRenderingEngine(renderingEngineId);
      const viewport = renderingEngine.getViewport(
        viewportId
      ) as Types.IVolumeViewport;

      viewport.setBlendMode(blendModeToUse);
      viewport.render();
    });
  },
});

addToggleButtonToToolbar({
  id: 'syncSlabThickness',
  title: 'Sync Slab Thickness',
  defaultToggle: false,
  onClick: (toggle) => {
    synchronizer.setEnabled(toggle);
  },
});

addToggleButtonToToolbar({
  id: 'ID_ROTATABLE',
  title: 'Enable rotation',
  defaultToggle: OptionRotatable,
  onClick: (toggle) => {
    OptionRotatable = toggle;
  },
});

addToggleButtonToToolbar({
  id: 'ID_DRAGGABLE',
  title: 'Enable Drag',
  defaultToggle: OptionDraggable,
  onClick: (toggle) => {
    OptionDraggable = toggle;
  },
});
addToggleButtonToToolbar({
  id: 'ID_SLAB',
  title: 'Enable Slab',
  defaultToggle: OptionSlab,
  onClick: (toggle) => {
    OptionSlab = toggle;
  },
});
addToggleButtonToToolbar({
  id: 'ID_INDICATOR',
  title: 'Show Indicator',
  defaultToggle: true,
  onClick: (toggle) => {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
    const crosshairsInstance = toolGroup.getToolInstance(
      CrosshairsTool.toolName
    );
    crosshairsInstance.configuration.viewportIndicators = toggle;
    getRenderingEngine(renderingEngineId).renderViewports(viewportIds);
  },
});

addToggleButtonToToolbar({
  id: 'ID_AUTOPAN',
  title: 'Auto pan',
  defaultToggle: false,
  onClick: (toggle) => {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
    const crosshairsInstance = toolGroup.getToolInstance(
      CrosshairsTool.toolName
    );
    crosshairsInstance.configuration.autoPan.enabled = toggle;
  },
});

addToggleButtonToToolbar({
  id: 'ID_Ortho',
  title: 'Orthogonal',
  defaultToggle: true,
  onClick: (toggle) => {
    const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
    const crosshairsInstance = toolGroup.getToolInstance(
      CrosshairsTool.toolName
    );
    crosshairsInstance.configuration.forceOrthogonal = toggle;
  },
});

function setUpSynchronizers() {
  synchronizer = createSlabThicknessSynchronizer(synchronizerId);

  // Add viewports to VOI synchronizers
  viewportIds.forEach((viewportId) => {
    synchronizer.add({
      renderingEngineId,
      viewportId,
    });
  });
  // Normally this would be left on, but here we are starting the demo in the
  // default state, which is to not have a synchronizer enabled.
  synchronizer.setEnabled(false);
}

/**
 * Runs the demo
 */
async function run() {
  // Init Cornerstone and related libraries
  await initDemo();

  // Add tools to Cornerstone3D
  cornerstoneTools.addTool(CrosshairsTool);

  // Get Cornerstone imageIds for the source data and fetch metadata into RAM
  const imageIds = await createImageIdsAndCacheMetaData({
    StudyInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463',
    SeriesInstanceUID:
      '1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561',
    wadoRsRoot:
      getLocalUrl() || 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb',
  });

  // Define a volume in memory
  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });

  // Instantiate a rendering engine
  const renderingEngine = new RenderingEngine(renderingEngineId);

  // Create the viewports
  const viewportInputArray = elements.map(({ id, element }, index: number) => {
    return {
      viewportId: id,
      type: ViewportType.ORTHOGRAPHIC,
      element: element,
      defaultOptions: {
        orientation: [
          Enums.OrientationAxis.AXIAL,
          Enums.OrientationAxis.SAGITTAL,
          Enums.OrientationAxis.CORONAL,
        ][index % 3],
        background: <Types.Point3>[0, 0, 0],
      },
    };
  });

  renderingEngine.setViewports(viewportInputArray);

  // Set the volume to load
  volume.load();

  // Set volumes on the viewports
  await setVolumesForViewports(
    renderingEngine,
    [
      {
        volumeId,
        callback: setCtTransferFunctionForVolumeActor,
      },
    ],
    viewportIds
  );

  // Define tool groups to add the segmentation display tool to
  const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);
  addManipulationBindings(toolGroup);

  // For the crosshairs to operate, the viewports must currently be
  // added ahead of setting the tool active. This will be improved in the future.
  viewportIds.forEach((viewportId) => {
    toolGroup.addViewport(viewportId, renderingEngineId);
  });

  // Manipulation Tools
  // Add Crosshairs tool and configure it to link the three viewports
  // These viewports could use different tool groups. See the PET-CT example
  // for a more complicated used case.

  const isMobile = window.matchMedia('(any-pointer:coarse)').matches;

  toolGroup.addTool(CrosshairsTool.toolName, {
    getReferenceLineColor,
    getReferenceLineDraggable,
    getReferenceLineRotatable,
    getReferenceLineSlabThicknessControlsOn,
    mobile: {
      enabled: isMobile,
      opacity: 0.8,
      handleRadius: 9,
    },
    viewportIndicators: true,
  });

  toolGroup.setToolActive(CrosshairsTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });

  setUpSynchronizers();

  // Render the image
  renderingEngine.renderViewports(viewportIds);
}

run();
