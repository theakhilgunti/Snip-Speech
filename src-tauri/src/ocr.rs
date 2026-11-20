//! Offline OCR using each operating system's built-in text recognition.
//! macOS: Apple Vision (`VNRecognizeTextRequest`). Nothing leaves the machine.
//! Windows (Windows.Media.Ocr) and Linux (Tesseract) are added in a later milestone.

/// Read the text out of PNG bytes. Lines are separated by `\n`, top to bottom.
#[cfg(target_os = "macos")]
pub fn recognize(png: &[u8]) -> Result<String, String> {
    use objc2::{rc::Retained, runtime::AnyObject, AnyThread};
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation,
        VNRequest,
    };

    let data = NSData::with_bytes(png);
    let options: Retained<NSDictionary<VNImageOption, AnyObject>> = NSDictionary::new();
    let handler =
        VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &options);

    let request = VNRecognizeTextRequest::new();
    request.setUsesLanguageCorrection(true);
    request.setAutomaticallyDetectsLanguage(true);

    let as_request: &VNRequest = &request;
    let requests = NSArray::from_slice(&[as_request]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| e.localizedDescription().to_string())?;

    let mut lines: Vec<String> = Vec::new();
    if let Some(results) = request.results() {
        for obs in results.iter() {
            if let Ok(text_obs) = obs.downcast::<VNRecognizedTextObservation>() {
                if let Some(best) = text_obs.topCandidates(1).iter().next() {
                    lines.push(best.string().to_string());
                }
            }
        }
    }
    Ok(lines.join("\n"))
}

#[cfg(not(target_os = "macos"))]
pub fn recognize(_png: &[u8]) -> Result<String, String> {
    Err("OCR isn't implemented for this operating system yet.".into())
}
