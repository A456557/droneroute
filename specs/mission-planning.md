# Mission planning

Plan a drone flight by placing waypoints on the map and configuring what the drone should do at each one.

## What you can do

- Place waypoints by clicking on the map.
- Set altitude, speed, gimbal pitch (camera angle), and heading for each waypoint.
- Choose a heading mode: follow the flight path, set a fixed angle, smooth transition between angles, or aim toward a point of interest.
- Choose a turn mode: smooth curve, stop at the waypoint then continue, or fly through without stopping.
- Reorder waypoints by dragging them in the sidebar list.
- Select multiple waypoints at once (Ctrl+click, Shift+click, or Ctrl+A) and edit them all in bulk.
- Rename waypoints by double-clicking their name.
- Use a global speed for the whole flight, or set a different speed for each waypoint.
- Use a global altitude for the whole flight, or set a different altitude for each waypoint.

## How it works

1. Press **W** or click the waypoint button in the toolbar to enter waypoint mode.
2. Click on the map to place waypoints. They appear as numbered markers.
3. Click a waypoint in the sidebar or on the map to select it and open its settings.
4. Adjust altitude, speed, heading, and turn mode as needed.
5. Add actions to any waypoint (see below).

### Waypoint actions

At each waypoint, you can tell the drone to:

- **Take a photo**.
- **Start or stop recording** video.
- **Rotate the gimbal** to a specific angle.
- **Smooth gimbal movement** (gradual interpolation to a new angle).
- **Rotate the drone** (yaw) clockwise or counter-clockwise.
- **Hover** in place for a set number of seconds.
- **Zoom** to a specific focal length.
- **Focus** on a specific point or set to infinite focus.

## Facade scan

- A facade scan flies a zigzag grid parallel to the selected wall segment,
  at the configured standoff distance, facing the wall.
- Scan altitudes scale with the building height (from near the ground to
  the roofline plus a ~25% margin): a 3 m wall is scanned between 1 and
  5 m, a 30 m building between 5 and 38 m (capped at 100 m).
- When a building is selected, its cadastral parcel is fetched (APICarto,
  no key) and the flight plan is kept inside the parcel limits: any
  waypoint outside the parcel (with a 2 m edge margin) is pulled back
  toward the wall, never below a 5 m minimum standoff.
- If a waypoint cannot fit inside the parcel even at minimum standoff
  (e.g. wall on the parcel boundary), it is kept at minimum standoff and
  flagged: the apply toast warns, and the route check reports it (R-11)
  as a possible neighboring-parcel overflight.
- Without a known parcel, generation works as before (no constraint).

## Good to know

- The flight path is drawn on the map as an animated dashed line. The animation speed reflects the drone's configured speed at each segment.
- You can mix manual waypoints with template-generated ones — they all work the same once placed.
- The sidebar shows an elevation graph so you can visualize altitude changes across the flight.
