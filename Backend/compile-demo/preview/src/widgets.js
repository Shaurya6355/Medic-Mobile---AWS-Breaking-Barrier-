// The enketo-core widgets the CHT webapp registers (cht-core webapp/src/js/enketo/widgets.js), in
// the same order. CHT's own widgets (db-object/select-contact, phone, countdown, mrdt, bikram-sambat,
// android-app-launcher, draw, hidden-group, ...) are NOT included: they need the CHT webapp
// (PouchDB, Angular services). The only one this form would use is db-object-widget for
// inputs/contact/_id (appearance select-contact), and that group is hidden when the form is opened
// from a contact, which is how the preview opens it.
import notewidget from "enketo-core/src/widget/note/notewidget";
import geopicker from "enketo-core/src/widget/geo/geopicker";
import tablewidget from "enketo-core/src/widget/table/tablewidget";
import radiopicker from "enketo-core/src/widget/radio/radiopicker";
import datepickerExtended from "enketo-core/src/widget/date/datepicker-extended";
import timepickerExtended from "enketo-core/src/widget/time/timepicker-extended";
import datetimepickerExtended from "enketo-core/src/widget/datetime/datetimepicker-extended";
import columns from "enketo-core/src/widget/columns/columns";
import filepicker from "enketo-core/src/widget/file/filepicker";
import selectMedia from "enketo-core/src/widget/select-media/select-media";
import rangeWidget from "enketo-core/src/widget/range/range-widget";
import urlWidget from "enketo-core/src/widget/url/url-widget";
import textMax from "enketo-core/src/widget/text-max/text-max";
import rating from "enketo-core/src/widget/rating/rating";
import thousandsSep from "enketo-core/src/widget/thousands-sep/thousands-sep";
import likertitem from "enketo-core/src/widget/select-likert/likertitem";
import selectDesktop from "enketo-core/src/widget/select-desktop/selectpicker";
import selectMobile from "enketo-core/src/widget/select-mobile/selectpicker";
import textarea from "enketo-core/src/widget/textarea/textarea";
import autocomplete from "enketo-core/src/widget/select-autocomplete/autocomplete";

export default [
  notewidget,
  geopicker,
  tablewidget,
  radiopicker,
  datepickerExtended,
  timepickerExtended,
  datetimepickerExtended,
  columns,
  filepicker,
  selectMedia,
  rangeWidget,
  urlWidget,
  textMax,
  rating,
  thousandsSep,
  likertitem,
  selectDesktop,
  selectMobile,
  textarea,
  autocomplete,
];
