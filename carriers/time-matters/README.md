# time:matters

Tracks time:matters orders by order number.

time:matters is a same-day and on-board courier in Neu-Isenburg near Frankfurt. It moves
time-critical shipments by air, rail and road, with on-board couriers, charters and its own
courier terminals, and has offices in Austria, the Netherlands, the United States, China,
Singapore and Malaysia. Its site is time-matters.com.

## How it works

`direct` reads the order from the service behind the tracking page,
`booking.time-matters.com/services/css-orders/orders/<number>/status/basic`: no session, token
or browser.

The reply's fields, order statuses and tracking point types are taken from the tracking page's
own script and translations. An order is a route of stops, and each stop lists its tracking
points with a scheduled, an estimated and an actual time. Each point that happened is an event:
its type is the `provider_code` and the page's wording for it the description. A type the
script does not list is kept without a stage.

The order's own status decides the stage. An arrival, an availability or a release means
different things at different stops, so those events stay in transit and the status says when
the shipment is delivered. A delivery is dated as the page dates it: by the hand-over at the
last stop, or by the arrival at a delivery address. A cancellation that went through replaces
the status, dated by its own clock, which the page reads as UTC.

`Available` is a shipment waiting at its last station. It is ready to collect when the order
ends at that station, and still in transit when the order ends at a door.

Before delivery, an order for a door gives the page's delivery time as the estimate: the
estimated arrival at the delivery address, else the scheduled one.

An airport is named by its town and code, a railway station by its name. Statuses and types are
worded in German or French for a reader of those languages, in English for everyone else.

Event clocks are read only with the offset the service states; a clock without one is rejected
instead of being given a zone.

The service is asked by the order's own address. A reply that names an order number must name
the requested one.

## Numbers

The tracking form takes S and digits, or eight or nine digits, each with a dash and digits
after it for a rebooked order. Those shapes are too generic for a rule, and no public page shows
one: time:matters is asked when it is selected or when a tracking link names it.

## Limitations

A rebooked order requires its printed dash.

Pickup and delivery addresses and the name a shipment was handed to are never read.

A missing order is the service's HTTP 404 with `no such order found`. Any other 404 is read as
a moved service, never as a missing parcel.

## Links

`booking.time-matters.com/en-US/tracking/<number>` opens one order, and so does the same page
in another language. The library reads the number from those addresses.

## Testing

`npm run test:carriers:live -- carriers/time-matters`
