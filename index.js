const GRID_SIZE = 32;
const BACKGROUND_COLOR = [0.1, 0.1, 0.1, 1.0];

const canvas = document.querySelector("canvas")

if (!navigator.gpu) {
  throw new Error("WebGPU not supported on this browser.");
}

// initialize webgpu
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  throw new Error("No appropriate GPUAdapter found.");
}

const device = await adapter.requestDevice();

// configure canvas
const context = canvas.getContext("webgpu");
const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
context.configure({
  device,
  format: canvasFormat,
});

// define cell vertices and vertex buffer
const createSquareVertices = (size = 0.8) => {
  // declare vertices for a square in clip space
  return new Float32Array([
  //   X,    Y,
    -size, -size, // Triangle 1 (Blue)
     size, -size,
     size,  size,
  
    -size, -size, // Triangle 2 (Red)
     size,  size,
    -size,  size,
  ]);
}

const createGpuBuffer = (vertices = new Float32Array([]), label = "buffer") => {
  const vertexBuffer = device.createBuffer({
    label,
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  return vertexBuffer
}

const vertices = createSquareVertices(0.8)
const vertexBuffer = createGpuBuffer(vertices, "Cell vertices")
device.queue.writeBuffer(vertexBuffer, 0, vertices)

// define vertex data structure
const vertexBufferLayout = {
  arrayStride: 8, // number of bytes the GPU needs to skip forward for the next buffer
  attributes: [{ // deccription of informations encoded into each vertex
    format: "float32x2", // one of GPUVertexFormat types
    offset: 0, // offset between attributes, useful for multiple attribute vertices
    shaderLocation: 0, // number between 0 and 16 used to map attributes to vertex shader inputs
  }],
};

// define vertex and fragment shaders and its module
const cellShader = /* wgsl */`
  struct VertexInput {
    @location(0) pos: vec2f, // flag function input to use vertex attribute at location 0
    @builtin(instance_index) instance: u32, // use instance index as fn attribute 
  };

  struct VertexOutput {
    @builtin(position) pos: vec4f, // flag function return value to be used as final vertex position
    @location(0) cell: vec2f,
  };

  @group(0) @binding(0) var<uniform> grid: vec2f; // define a vec2f uniform called "grid" bound at group and binding 0
  @group(0) @binding(1) var<storage> cellState: array<u32>;

  @vertex // flag function as vertex shader fn
  fn vertexMain(input: VertexInput) -> VertexOutput { // use VertexInput and VertexOutput structs to define fn input and output types
    let i = f32(input.instance); // cast instance index to float
    let cell = vec2f(i % grid.x, floor(i / grid.x)); // use instance index to position cell
    let state = f32(cellState[input.instance]); // get current cell state
    let cellOffset = cell / grid * 2; // compute the offset to cell
    // scale cell to 0 if inactive
    let gridPos = (input.pos * state + 1) / grid - 1 + cellOffset; // add 1 to the position before dividing by the grid size, then shift it by -1 to place it at the bottom left

    var output: VertexOutput;
    output.pos = vec4f(gridPos, 0, 1);
    output.cell = cell;
    return output; // could also be written: vec4f(pos.x, pos.y, 0, 1)
  }

  @fragment // flag function as fragment shader
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f { // flag return value to be used as final pixel color
    let c = input.cell / grid; // get cell red and green color based on position
    return vec4f(c, 1 - c.x, 1); // (Red, Green, Blue, Alpha)
  }
`

const cellShaderModule = device.createShaderModule({
  label: "Cell shader",
  code: cellShader
})

// create render pipeline
const cellPipeline = device.createRenderPipeline({
  label: "Cell pipeline",
  layout: "auto", // create bind groups automatically for bindings created in the shader code
  vertex: {
    module: cellShaderModule,
    entryPoint: "vertexMain", // define which fn in the shader to call for each vertex
    buffers: [vertexBufferLayout], // describe how the vertex data is formatted when used with vertex buffer
  },
  fragment: {
    module: cellShaderModule,
    entryPoint: "fragmentMain", // define which fn in the shader to call for each pixel given to the fragment shader
    targets: [{
      format: canvasFormat // tell the pipeline the format of its output texture(s)
    }]
  }
})

// create uniform array and buffer to describe the grid
const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
const uniformBuffer = device.createBuffer({
  label: "Grid Uniforms",
  size: uniformArray.byteLength,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

// create an array containgin the active state of each cell
const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
// create a storage buffer to hold the cell state
const cellStateStorage = device.createBuffer({
  label: 'Cell state',
  size: cellStateArray.byteLength,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});

// make every third cell active by setting it to 1, leave others at 0
for (let i = 0; i < cellStateArray.length; i += 3) {
  cellStateArray[i] = 1;
}
console.log(cellStateArray)
device.queue.writeBuffer(cellStateStorage, 0, cellStateArray);

// create bind group to pass data to shader
const bindGroup = device.createBindGroup({
  label: "Cell renderer bind group",
  layout: cellPipeline.getBindGroupLayout(0), // corresponds to "@group(0)" in shader code
  entries: [{
    binding: 0, // corresponds to "@binding(0)" in shader code
    resource: {
      buffer: uniformBuffer
    },
  }, {
    binding: 1, // corresponds to "@binding(1)" in shader code
    resource: {
      buffer: cellStateStorage
    },
  }]
})


// declare render pass and clear canvas
const encoder = device.createCommandEncoder();

const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: context.getCurrentTexture().createView(),
    loadOp: "clear",
    clearValue: BACKGROUND_COLOR,
    storeOp: "store",
  }]
});

// start rendering using pipeline, vertexBuffer and number of vertices
pass.setPipeline(cellPipeline);
pass.setVertexBuffer(0, vertexBuffer); // pass vertex buffer as 0th element in the pipeline's vertex.buffers definition
pass.setBindGroup(0, bindGroup) // corresponds to "@group(0)" in shader code
pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE); // draw 16 instances of the cell
pass.end()

// store render pass in a command buffer to send these to the gpu later
const commandBuffer = encoder.finish()
// submit command queue to gpu, once submitted, the command buffer won't be usable again
device.queue.submit([ commandBuffer ])
// could be simplified to: device.queue.submit([ encoder.finish() ])